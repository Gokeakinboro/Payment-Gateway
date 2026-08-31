'use strict';
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../../../utils/db');
const { requireAuth, requireApiKey, requireSuperAdmin, requireCompliance } = require('../../../middleware/auth');
const { ok, fail, notFound, created, koboToNaira, generateRef } = require('../../../utils/helpers');
const { logAudit } = require('../../../services/auditService');
const { notifyRailIncident, recordRailResult, checkRailBalanceAndAlert } = require('../services/railHealth');
const { BANKS, resolveBank } = require('../../../data/nibssBanks');
const { syncRailFloat } = require('../services/railFloat');
const { logger } = require('../../../utils/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── "On-us" payout destinations ──────────────────────────────────────────────
// On-us bank codes per rail — a transfer TO these codes settles inside that
// rail's own network (cheaper). PAYOUT_ONUS fee config applies; everything else
// uses PAYOUT. Codes are CBN/NIBSS institution codes. Parallex's code comes from
// env so it stays in sync with parallexTransferService.js.
const ON_US_CODES_BY_RAIL = {
  palmpay:  new Set(['100033']),
  parallex: new Set([process.env.PARALLEX_TRANSFER_BANK_CODE || '999015']),
};
// Union of all on-us codes across every rail — used for merchant fee pricing at
// payout creation time (before a specific rail is assigned). A destination that
// is on-us for ANY rail gets the cheaper merchant rate.
const ALL_ON_US_CODES = new Set(Object.values(ON_US_CODES_BY_RAIL).flatMap(s => [...s]));

// railName supplied → rail-specific check (float guard at dispatch).
// railName omitted  → checks all on-us codes (merchant fee pricing at creation).
function isOnUsBank(bankCode, railName) {
  const code = String(bankCode || '').trim();
  if (!railName) return ALL_ON_US_CODES.has(code);
  const n = railName.toLowerCase();
  for (const [key, codes] of Object.entries(ON_US_CODES_BY_RAIL)) {
    if (n.includes(key)) return codes.has(code);
  }
  return false;
}

// ── Per-rail payout liquidity helpers ─────────────────────────────────────────
// Payouts are pre-funded PER RAIL: a merchant holds one merchant_wallets row per
// rail and may only pay out through a rail up to (a) what they funded there AND
// (b) that rail's remaining DAILY send-out cap. These run inside a tx so the read
// and the guarded debit see a consistent snapshot.

// Remaining daily send-out capacity on a rail (cap − today's non-failed
// disbursements, in beneficiary kobo). null cap = unlimited.
async function remainingDailyCap(tx, railId, cap) {
  if (cap == null) return null;
  const rows = await tx.$queryRaw`
    SELECT COALESCE(SUM(amount),0) AS u FROM rail_disbursements
    WHERE rail_id = ${railId}::uuid AND created_at >= date_trunc('day', NOW())
      AND status NOT IN ('failed','reversed')`;
  const rem = BigInt(cap) - BigInt(rows[0].u);
  return rem > 0n ? rem : 0n;
}

// The DISBURSING rails for a merchant. Priority order:
//   1. merchant_payout_splits (is_active=true, pct must sum to 100) → multi-rail split
//   2. merchants.payout_rail_id (per-merchant single override)
//   3. payment_rails.is_default_payout (global default)
// Returns an array of { rail_id, rail_name, daily_value_cap, pct } always summing
// to 100. Single-entry array for non-split merchants (pct=100). Returns [] on
// failure (no route, rail not LIVE, etc.) — caller throws NO_ROUTE.
async function resolveRouteRail(tx, merchantId) {
  // Check for active splits first.
  const splits = await tx.$queryRaw`
    SELECT ps.pct, pr.id AS rail_id, pr.name AS rail_name, pr.daily_value_cap,
           pr.status, pr.payout_enabled
    FROM merchant_payout_splits ps
    JOIN payment_rails pr ON pr.id = ps.rail_id
    WHERE ps.merchant_id = ${merchantId}::uuid AND ps.is_active = true
    ORDER BY ps.pct DESC`;
  if (splits.length > 0) {
    const live = splits.filter(s => s.status === 'LIVE' && s.payout_enabled);
    if (!live.length) return [];
    // Normalise percentages to sum to 100 in case some rails are offline.
    const total = live.reduce((s, r) => s + Number(r.pct), 0);
    return live.map((s, i) => ({
      rail_id: s.rail_id, rail_name: s.rail_name, daily_value_cap: s.daily_value_cap,
      pct: i < live.length - 1 ? Math.round(Number(s.pct) * 100 / total) : null, // last gets remainder
    })).map((s, i, arr) => {
      if (s.pct !== null) return s;
      const used = arr.slice(0, i).reduce((a, b) => a + b.pct, 0);
      return { ...s, pct: 100 - used };
    });
  }
  // Fall back to single-rail (per-merchant override or global default).
  const rows = await tx.$queryRaw`
    SELECT COALESCE(mr.id, dr.id)                           AS rail_id,
           COALESCE(mr.name, dr.name)                       AS rail_name,
           COALESCE(mr.daily_value_cap, dr.daily_value_cap) AS daily_value_cap,
           COALESCE(mr.status, dr.status)::text             AS status,
           COALESCE(mr.payout_enabled, dr.payout_enabled)   AS payout_enabled
    FROM merchants m
    LEFT JOIN payment_rails mr ON mr.id = m.payout_rail_id
    LEFT JOIN payment_rails dr ON dr.is_default_payout = true
    WHERE m.id = ${merchantId}::uuid`;
  const r = rows[0];
  if (!r || !r.rail_id) return [];
  if (r.status !== 'LIVE' || !r.payout_enabled) return [];
  return [{ rail_id: r.rail_id, rail_name: r.rail_name, daily_value_cap: r.daily_value_cap, pct: 100 }];
}

// ── Dual-auth middleware: accepts JWT Bearer token OR sk_live_/sk_test_ API key ──
function requireAuthOrApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  // Payouts are prepaid (funded wallet = the safeguard), so a merchant still in
  // KYC may run LIVE payouts. Opt this router into live keys for unverified
  // merchants; SUSPENDED/REJECTED accounts are still blocked in the handler.
  req.allowInactiveLivePayout = true;
  if (auth.startsWith('Bearer sk_live_') || auth.startsWith('Bearer sk_test_')) {
    // API key path — sets req.merchant
    requireApiKey(req, res, () => {
      // Normalise to req.user shape so route handler works with both auth types
      if (req.merchant && !req.user) {
        req.user = {
          id:       req.merchant.userId || req.merchant.id,
          role:     'MERCHANT',
          merchant: { id: req.merchant.id, merchantCode: req.merchant.merchantCode,
                      kycStatus: req.merchant.kycStatus, isActive: req.merchant.isActive },
        };
      }
      next();
    });
  } else {
    // JWT path — sets req.user
    requireAuth(req, res, next);
  }
}

const validate = rules => async (req, res, next) => {
  await Promise.all(rules.map(r => r.run(req)));
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ status:false, message:e.array()[0].msg, error_code:'VALIDATION_ERROR' });
  next();
};

// ── GET /api/v1/payouts/wallet — MERCHANT view: TOTAL balance only ───────────
// Rails are Paylode-internal and MUST NEVER be exposed to the merchant. The
// merchant sees a single total across all their per-rail balances.
router.get('/wallet', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const rows = await prisma.merchantWallet.findMany({
      where: { merchantId }, select: { balance: true, lastFundedAt: true },
    });
    const total = rows.reduce((s, r) => s + r.balance, 0n);
    const lastFunded = rows.map(r => r.lastFundedAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
    ok(res, {
      balance:        Number(total),
      balance_naira:  koboToNaira(total),
      last_funded_at: lastFunded,
      merchant_id:    merchantId,
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/wallet/fund — SA credits/debits a merchant PER RAIL ──
// Payouts are pre-funded per rail: this is the POST-CONFIRMATION credit (SA has
// already confirmed the merchant's deposit landed in the rail). Accepts EITHER a
// single { rail_id, amount } OR allocations:[{rail_id, amount}] (a deposit split
// across the rails the merchant was told to fund). rail_id is REQUIRED.
// direction: 'credit' (default) | 'debit'. Debit cannot drive a rail balance negative.
router.post('/wallet/fund', requireAuth, requireSuperAdmin,
  validate([
    body('merchant_id').notEmpty().withMessage('merchant_id required'),
    body('reference').notEmpty().withMessage('payment reference required'),
    body('description').optional().isString(),
    body('direction').optional().isIn(['credit', 'debit']),
  ]),
  async (req, res, next) => {
    try {
      const { merchant_id, reference, description } = req.body;
      const direction = req.body.direction === 'debit' ? 'debit' : 'credit';

      // Normalise to per-rail funding lines.
      let moves = [];
      if (Array.isArray(req.body.allocations) && req.body.allocations.length) {
        moves = req.body.allocations.map(a => ({ rail_id: a.rail_id, amount: a.amount }));
      } else if (req.body.rail_id != null && req.body.amount != null) {
        moves = [{ rail_id: req.body.rail_id, amount: req.body.amount }];
      }
      if (!moves.length)
        return fail(res, 'Provide rail_id + amount, or allocations:[{rail_id, amount}] — payouts are funded per rail.');
      for (const m of moves) {
        if (!m.rail_id) return fail(res, 'Each funding line needs a rail_id (which bank/rail the merchant funded).');
        if (!(Number.isInteger(Number(m.amount)) && Number(m.amount) > 0))
          return fail(res, 'Each funding line needs a positive amount in kobo.');
      }

      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id } });
      if (!merchant) return notFound(res, 'Merchant');

      // A payout ROUTE must be chosen before funding lands. The funding UI passes the
      // chosen route as route_rail_id; set it here (any LIVE payout rail). After that,
      // the merchant MUST have a route (own override or the global default) or we reject.
      if (req.body.route_rail_id) {
        const rr = await prisma.paymentRail.findUnique({ where: { id: req.body.route_rail_id }, select: { id: true, name: true, status: true, payoutEnabled: true } });
        if (!rr) return fail(res, 'Unknown route rail.');
        if (rr.status !== 'LIVE' || !rr.payoutEnabled) return fail(res, `${rr.name} is not a live payout rail — cannot route to it.`, 'RAIL_NOT_LIVE');
        await prisma.merchant.update({ where: { id: merchant_id }, data: { payoutRailId: rr.id } });
        merchant.payoutRailId = rr.id;
      }
      if (!merchant.payoutRailId) {
        const def = await prisma.paymentRail.findFirst({ where: { isDefaultPayout: true }, select: { id: true } });
        if (!def) return fail(res, 'Choose a payout route for this merchant before funding.', 'ROUTE_REQUIRED');
      }

      // Rails must exist and be payout-enabled (you can't pre-fund a rail we can't send through).
      const railIds = [...new Set(moves.map(m => m.rail_id))];
      const rails = await prisma.paymentRail.findMany({
        where: { id: { in: railIds } }, select: { id: true, name: true, payoutEnabled: true },
      });
      const railById = Object.fromEntries(rails.map(r => [r.id, r]));
      for (const id of railIds) {
        const r = railById[id];
        if (!r) return fail(res, 'Unknown rail in funding.');
        if (!r.payoutEnabled) return fail(res, `${r.name} is not payout-enabled — cannot fund it.`);
      }

      const out = await prisma.$transaction(async (tx) => {
        const lines = [];
        for (const m of moves) {
          const amt = BigInt(m.amount);
          let w = await tx.merchantWallet.findFirst({ where: { merchantId: merchant_id, railId: m.rail_id } });
          const before = w ? w.balance : 0n;
          const after  = direction === 'debit' ? before - amt : before + amt;
          if (after < 0n) throw Object.assign(new Error(
            `Debit exceeds the ${railById[m.rail_id].name} balance (₦${koboToNaira(before).toLocaleString('en-NG')}).`), { _client: true });
          if (!w) {
            w = await tx.merchantWallet.create({ data: {
              merchantId: merchant_id, railId: m.rail_id, balance: after,
              lastFundedAt: direction === 'credit' ? new Date() : null, fundedBy: req.user.id,
            }});
          } else {
            w = await tx.merchantWallet.update({ where: { id: w.id }, data: {
              balance: after, ...(direction === 'credit' ? { lastFundedAt: new Date(), fundedBy: req.user.id } : {}),
            }});
          }
          await tx.walletLedger.create({ data: {
            merchantId: merchant_id, railId: m.rail_id,
            entryType: direction === 'debit' ? 'DEBIT' : 'CREDIT',
            amount: amt, balanceBefore: before, balanceAfter: after, reference,
            description: description || `${direction === 'debit' ? 'SA debit' : 'Wallet funding'} (${railById[m.rail_id].name})`,
            createdBy: req.user.id,
          }});
          lines.push({ rail_id: m.rail_id, rail_name: railById[m.rail_id].name, amount: Number(amt), new_balance: Number(after) });
        }
        const allRows = await tx.merchantWallet.findMany({ where: { merchantId: merchant_id }, select: { balance: true } });
        const total = allRows.reduce((s, r) => s + r.balance, 0n);
        return { lines, total };
      });

      const totalMoved = moves.reduce((s, m) => s + BigInt(m.amount), 0n);
      await logAudit(req.user.id, direction === 'debit' ? 'WALLET_DEBITED' : 'WALLET_FUNDED', 'merchant_wallets', merchant_id,
        {}, { lines: out.lines, new_total: Number(out.total) },
        `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(totalMoved).toLocaleString()} across ${out.lines.length} rail(s) — Ref: ${reference}`);

      ok(res, {
        merchant_id, business_name: merchant.businessName, direction,
        amount: koboToNaira(totalMoved),
        lines: out.lines.map(l => ({ ...l, amount_naira: koboToNaira(BigInt(l.amount)), new_balance_naira: koboToNaira(BigInt(l.new_balance)) })),
        new_balance: koboToNaira(out.total), reference,
      }, `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(totalMoved).toLocaleString()} ${direction === 'debit' ? 'from' : 'to'} ${merchant.businessName}`);
    } catch (e) {
      if (e && e._client) return fail(res, e.message);
      next(e);
    }
  }
);

// ── POST /api/v1/payouts/admin/wallet/rebalance — SA moves a merchant's pre-funded
// payout balance between rails ────────────────────────────────────────────────
// Payouts are pre-funded PER RAIL, so moving a merchant from one rail to another is
// a REAL movement of money between our rail bank accounts. This records the LOGICAL
// move immediately (per-rail wallet A→B) plus a treasury-transfer OBLIGATION
// (rail_rebalances, status='pending') that ops executes at the banks. We do NOT
// touch float_balance here: for rails with a balance API it is overwritten by the
// next float sync once the physical transfer lands, and the routing float guard
// safely prevents disbursing from the destination rail before then.
// body: { merchant_id, moves:[{from_rail_id, to_rail_id, amount(kobo)}], reference?, note? }
router.post('/admin/wallet/rebalance', requireAuth, requireSuperAdmin,
  validate([ body('merchant_id').notEmpty().withMessage('merchant_id required') ]),
  async (req, res, next) => {
    try {
      const { merchant_id, reference, note } = req.body;
      const moves = Array.isArray(req.body.moves) ? req.body.moves
        : (req.body.from_rail_id && req.body.to_rail_id && req.body.amount
            ? [{ from_rail_id: req.body.from_rail_id, to_rail_id: req.body.to_rail_id, amount: req.body.amount }] : []);
      if (!moves.length) return fail(res, 'moves:[{from_rail_id, to_rail_id, amount}] required');
      for (const m of moves) {
        if (!m.from_rail_id || !m.to_rail_id) return fail(res, 'Each move needs from_rail_id and to_rail_id.');
        if (m.from_rail_id === m.to_rail_id) return fail(res, 'A move must be between two different rails.');
        if (!(Number.isInteger(Number(m.amount)) && Number(m.amount) > 0)) return fail(res, 'Each move needs a positive amount in kobo.');
      }

      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id } });
      if (!merchant) return notFound(res, 'Merchant');

      const railIds = [...new Set(moves.flatMap(m => [m.from_rail_id, m.to_rail_id]))];
      const rails = await prisma.paymentRail.findMany({ where: { id: { in: railIds } }, select: { id: true, name: true, payoutEnabled: true } });
      const railById = Object.fromEntries(rails.map(r => [r.id, r]));
      for (const id of railIds) {
        const r = railById[id];
        if (!r) return fail(res, 'Unknown rail in rebalance.');
        if (!r.payoutEnabled) return fail(res, `${r.name} is not payout-enabled.`);
      }

      const out = await prisma.$transaction(async (tx) => {
        const applied = [];
        for (const m of moves) {
          const amt = BigInt(m.amount);
          const dec = await tx.$queryRaw`
            UPDATE merchant_wallets SET balance = balance - ${amt}, last_used_at = NOW(), updated_at = NOW()
            WHERE merchant_id = ${merchant_id}::uuid AND rail_id = ${m.from_rail_id}::uuid AND balance >= ${amt}
            RETURNING balance`;
          if (!dec.length) throw Object.assign(new Error(
            `${railById[m.from_rail_id].name} has insufficient balance for this rebalance.`), { _client: true });
          const fromAfter = BigInt(dec[0].balance);
          let toW = await tx.merchantWallet.findFirst({ where: { merchantId: merchant_id, railId: m.to_rail_id } });
          const toBefore = toW ? toW.balance : 0n;
          const toAfter = toBefore + amt;
          if (!toW) {
            await tx.merchantWallet.create({ data: { merchantId: merchant_id, railId: m.to_rail_id, balance: toAfter, fundedBy: req.user.id } });
          } else {
            await tx.merchantWallet.update({ where: { id: toW.id }, data: { balance: toAfter } });
          }
          await tx.$executeRaw`
            INSERT INTO wallet_ledger (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
            VALUES
              (${merchant_id}::uuid, ${m.from_rail_id}::uuid, 'REBALANCE', ${amt}, ${fromAfter + amt}, ${fromAfter}, ${reference || 'REBALANCE'},
               ${'Rebalance OUT to ' + railById[m.to_rail_id].name}, ${req.user.id}::uuid, NOW()),
              (${merchant_id}::uuid, ${m.to_rail_id}::uuid, 'REBALANCE', ${amt}, ${toBefore}, ${toAfter}, ${reference || 'REBALANCE'},
               ${'Rebalance IN from ' + railById[m.from_rail_id].name}, ${req.user.id}::uuid, NOW())`;
          const obl = await tx.$queryRaw`
            INSERT INTO rail_rebalances (merchant_id, from_rail_id, to_rail_id, amount, status, reference, note, created_by, created_at, updated_at)
            VALUES (${merchant_id}::uuid, ${m.from_rail_id}::uuid, ${m.to_rail_id}::uuid, ${amt}, 'pending', ${reference || null}, ${note || null}, ${req.user.id}::uuid, NOW(), NOW())
            RETURNING id`;
          applied.push({ obligation_id: obl[0].id, from_rail: railById[m.from_rail_id].name, to_rail: railById[m.to_rail_id].name, amount: Number(amt) });
        }
        return applied;
      });

      const total = moves.reduce((s, m) => s + BigInt(m.amount), 0n);
      await logAudit(req.user.id, 'WALLET_REBALANCED', 'merchant_wallets', merchant_id, {}, { moves: out }, null,
        `Rebalanced ₦${koboToNaira(total).toLocaleString()} across ${out.length} move(s) for ${merchant.businessName} — treasury transfer pending`);

      ok(res, {
        merchant_id, business_name: merchant.businessName,
        moves: out.map(m => ({ ...m, amount_naira: koboToNaira(BigInt(m.amount)) })),
        treasury_note: 'Logical move applied. Physically transfer the funds between the rail bank accounts, then mark each obligation settled.',
      }, `Rebalanced ₦${koboToNaira(total).toLocaleString()} — ${out.length} treasury transfer(s) pending`);
    } catch (e) {
      if (e && e._client) return fail(res, e.message);
      next(e);
    }
  }
);

// ── GET /api/v1/payouts/admin/wallet/rebalances — treasury-transfer obligations ──
router.get('/admin/wallet/rebalances', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const rows = await prisma.$queryRaw`
      SELECT rr.id, rr.merchant_id, m.business_name, rr.amount, rr.status, rr.reference, rr.note,
             rr.created_at, rr.settled_at, fr.name AS from_rail, tr.name AS to_rail
      FROM rail_rebalances rr
      JOIN merchants m ON m.id = rr.merchant_id
      JOIN payment_rails fr ON fr.id = rr.from_rail_id
      JOIN payment_rails tr ON tr.id = rr.to_rail_id
      WHERE (${status} = 'all' OR rr.status = ${status})
      ORDER BY rr.created_at DESC LIMIT 200`;
    ok(res, rows.map(r => ({
      id: r.id, merchant_id: r.merchant_id, business_name: r.business_name,
      from_rail: r.from_rail, to_rail: r.to_rail,
      amount: Number(r.amount), amount_naira: koboToNaira(r.amount),
      status: r.status, reference: r.reference, note: r.note,
      created_at: r.created_at, settled_at: r.settled_at,
    })));
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/wallet/rebalance/:id/settle — mark the physical
// inter-bank transfer done ─────────────────────────────────────────────────────
router.post('/admin/wallet/rebalance/:id/settle', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const upd = await prisma.$queryRaw`
      UPDATE rail_rebalances SET status='settled', settled_at=NOW(), updated_at=NOW()
      WHERE id = ${id}::uuid AND status='pending' RETURNING id, amount`;
    if (!upd.length) return fail(res, 'No pending rebalance with that id.');
    await logAudit(req.user.id, 'WALLET_REBALANCE_SETTLED', 'rail_rebalances', id, {}, { settled: true }, null,
      `Treasury transfer settled — ₦${koboToNaira(upd[0].amount).toLocaleString()}`);
    ok(res, { id, status: 'settled' }, 'Rebalance marked settled');
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/wallet/ledger — wallet transaction history ────────────
router.get('/wallet/ledger', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role === 'MERCHANT'
      ? req.user.merchant?.id
      : req.query.merchant_id;
    if (!merchantId) return fail(res, 'merchant_id required');

    const ledger = await prisma.$queryRaw`
      SELECT wl.*, u.email as created_by_email
      FROM wallet_ledger wl
      LEFT JOIN users u ON wl.created_by = u.id
      WHERE wl.merchant_id = ${merchantId}::uuid
      ORDER BY wl.created_at DESC
      LIMIT 100
    `;

    ok(res, ledger.map(l => ({
      ...l,
      amount_naira:         koboToNaira(l.amount),
      balance_before_naira: koboToNaira(l.balance_before),
      balance_after_naira:  koboToNaira(l.balance_after),
    })));
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/banks — list all Nigerian banks (NIBSS registry) ─────
// Canonical 6-digit NIBSS codes (816 banks incl. fintechs). This is the SAME
// code set the payout rail expects, so merchants/SDKs resolve names → codes here.
router.get('/banks', requireAuth, async (req, res, next) => {
  try {
    ok(res, BANKS.map(b => ({ bank_code: b.code, bank_name: b.name })));
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/batches — create payout batch ───────────────────────
// Accepts EITHER a merchant JWT (dashboard) or sk_live_/sk_test_ API key (SDK)
router.post('/batches', requireAuthOrApiKey,
  validate([
    body('description').optional().isString(),
    body('scheduled_at').optional().isISO8601(),
    body('items').isArray({ min: 1 }).withMessage('At least one beneficiary required'),
    body('items.*.account_number').isLength({ min: 10, max: 10 }).matches(/^\d+$/).withMessage('Each account_number must be 10 digits'),
    // bank_code OR bank_name accepted (resolved below). At least one is required.
    body('items.*').custom(it => it && (it.bank_code || it.bank_name)).withMessage('Each item needs a bank_code or bank_name'),
    body('items.*.amount').isInt({ min: 1 }).withMessage('amount in kobo required for each item'),
  ]),
  async (req, res, next) => {
    try {
      const merchantId = req.user.merchant?.id;
      if (!merchantId) return fail(res, 'No merchant account');

      // ── Resolve bank_name → bank_code where a code wasn't supplied ───────────
      // Lets SDK merchants send a human bank name; the file-upload path resolves
      // client-side, but this makes the API forgiving too. Reject unknown banks.
      const bankErrors = [];
      for (let i = 0; i < (req.body.items || []).length; i++) {
        const it = req.body.items[i];
        if (!it.bank_code && it.bank_name) {
          const hit = resolveBank(it.bank_name);
          if (hit) { it.bank_code = hit.code; it.bank_name = hit.name; }
          else bankErrors.push(`Item ${i + 1}: bank "${it.bank_name}" not recognised`);
        } else if (it.bank_code) {
          const hit = resolveBank(it.bank_code);   // normalises / validates the code too
          if (hit) it.bank_code = hit.code;
        }
      }
      if (bankErrors.length)
        return res.status(400).json({ status: false, message: bankErrors[0], errors: bankErrors, error_code: 'BANK_UNRESOLVED' });

      const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
      if (!merchant) return fail(res, 'No merchant account');
      // Recall window setting (raw — not in Prisma schema).
      const recallRow = await prisma.$queryRawUnsafe(
        'SELECT payout_recall_window_minutes FROM merchants WHERE id = $1::uuid', merchantId);
      const recallMinutes = Number(recallRow[0]?.payout_recall_window_minutes || 0);
      const hasRecallWindow = recallMinutes > 0;
      // Payouts are prepaid — a merchant still undergoing KYC MAY run live payouts
      // as long as their wallet is funded (the balance check below is the safeguard).
      // Only a SUSPENDED or REJECTED account is hard-blocked from payouts.
      if (['SUSPENDED', 'KYC_REJECTED'].includes(merchant.kycStatus))
        return fail(res, 'Account is suspended or rejected — payouts are disabled', 'ACCOUNT_BLOCKED');

      const { description, scheduled_at, items } = req.body;

      const defaultNarration = null; // Narration comes from the merchant; never auto-generated.

      // ── Lookup payout fee rate (platform default or per-merchant override) ─────
      // Payout pricing is tiered by destination: PAYOUT_ONUS for on-us (PalmPay)
      // beneficiaries, PAYOUT for every other bank. Each tier resolves its own
      // editable rate config (per-merchant override wins over the platform default),
      // and each falls back to the standard PAYOUT config if the on-us tier isn't
      // configured (so behaviour is unchanged until PAYOUT_ONUS is seeded).
      const VAT_RATE = 0.075; // 7.5% Nigerian VAT on service fees
      // The exact channel MUST win over the 'ALL' fallback. 'ALL' sorts before the
      // PAYOUT* channels alphabetically, so orderBy desc puts the specific channel
      // first (else 'ALL' wrongly wins — same bug class as cards).
      const resolveRate = async (channel) => {
        const [m, p] = await Promise.all([
          prisma.merchantRateConfig.findFirst({
            where: { merchantId, channel: { in: [channel, 'ALL'] } },
            orderBy: { channel: 'desc' },
          }),
          prisma.platformRateConfig.findFirst({
            where: { channel: { in: [channel, 'ALL'] } },
            orderBy: { channel: 'desc' },
          }),
        ]);
        return m || p;
      };
      const payoutRate = await resolveRate('PAYOUT');
      // On-us tier: prefer a PAYOUT_ONUS config, else fall back to the standard one.
      const onUsRate = (await resolveRate('PAYOUT_ONUS')) || payoutRate;
      const toRate = (cfg) => ({
        rate:    cfg ? Number(cfg.rate)      : 0,
        flatFee: cfg ? BigInt(cfg.flatFee)   : 0n,
        cap:     cfg ? BigInt(cfg.cap)       : 0n,
        min:     cfg ? BigInt(cfg.minCharge) : 0n,
      });
      const rateOther = toRate(payoutRate);
      const rateOnUs  = toRate(onUsRate);
      const feeRate   = rateOther.rate;   // batch-level rate (other-bank reference)

      // ── Per-item fee + VAT calculation (tier picked by destination) ─────────────
      const itemsWithFees = items.map(item => {
        const amt = BigInt(item.amount);
        const r   = isOnUsBank(item.bank_code) ? rateOnUs : rateOther;
        let fee   = amt * BigInt(Math.round(r.rate * 1_000_000)) / 1_000_000n + r.flatFee;
        if (r.min > 0n && fee < r.min) fee = r.min;
        if (r.cap > 0n && fee > r.cap) fee = r.cap;
        const vat   = fee * BigInt(Math.round(VAT_RATE * 1_000_000)) / 1_000_000n;
        const total = amt + fee + vat;  // what gets deducted from wallet for this item
        return { ...item, fee, vat, total };
      });

      const totalAmount   = itemsWithFees.reduce((s, i) => s + BigInt(i.amount), 0n);
      const totalFee      = itemsWithFees.reduce((s, i) => s + i.fee,  0n);
      const totalVat      = itemsWithFees.reduce((s, i) => s + i.vat,  0n);
      const totalDeduction = totalAmount + totalFee + totalVat;  // full wallet deduction

      // ── Per-rail pre-funded balances drive the payout ───────────────────────────
      // A merchant pre-funds each rail separately; a payout draws ONLY from the
      // rail(s) they funded, never past a rail's remaining DAILY send-out cap. We
      // assign each beneficiary to a rail here (balance + cap aware) and debit that
      // rail's wallet atomically. SA still triggers disbursement via
      // POST /admin/batches/:id/route, which executes this same per-rail split.
      const batchRef    = generateRef('PAY');
      // Recall window: pending_review delays dispatch so merchant can edit/recall.
      // NE is pre-fetched during the window to make dispatch Transfer-only.
      const scheduledAt = hasRecallWindow
        ? new Date(Date.now() + recallMinutes * 60_000)
        : (scheduled_at ? new Date(scheduled_at) : new Date());
      const batchStatus = hasRecallWindow ? 'pending_review' : 'needs_routing';
      const itemStatus  = 'queued';

      let batchId, walletAfterTotal;
      try {
        await prisma.$transaction(async (tx) => {
          // ── Route-driven, pooled-balance disbursement (rail-agnostic) ─────────────
          // Routing priority: per-merchant splits → per-merchant override → global default.
          // The merchant sees ONE balance regardless of how many rails are used.
          const routeRails = await resolveRouteRail(tx, merchantId);
          if (!routeRails.length)
            throw Object.assign(new Error('No payout route configured — set a default rail (SA → Merchant Routing).'),
              { _client: true, _code: 'NO_ROUTE' });
          const primaryRail = routeRails[0]; // highest-pct or sole rail — used for batch row + ledger

          // Pooled balance — lock every row we might debit.
          const walletRows = await tx.$queryRaw`
            SELECT id, balance FROM merchant_wallets
            WHERE merchant_id = ${merchantId}::uuid AND balance > 0
            ORDER BY balance DESC FOR UPDATE`;
          const pooled = walletRows.reduce((s, r) => s + BigInt(r.balance), 0n);
          if (pooled < totalDeduction)
            throw Object.assign(new Error(
              `Insufficient balance. Available ₦${koboToNaira(pooled).toLocaleString('en-NG')}, ` +
              `required ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')} ` +
              `(₦${koboToNaira(totalAmount).toLocaleString('en-NG')} payouts + ₦${koboToNaira(totalFee).toLocaleString('en-NG')} fee + ₦${koboToNaira(totalVat).toLocaleString('en-NG')} VAT).`),
              { _client: true, _code: 'INSUFFICIENT_BALANCE' });

          // Per-rail daily-cap check: each rail must have headroom for its share.
          for (const rr of routeRails) {
            const railShare = BigInt(Math.round(Number(totalAmount) * rr.pct / 100));
            const rem = await remainingDailyCap(tx, rr.rail_id, rr.daily_value_cap);
            if (rem != null && rem < railShare)
              throw Object.assign(new Error(
                `Daily payout limit reached on ${rr.rail_name} for this amount — try again later, or adjust routing.`),
                { _client: true, _code: 'DAILY_CAP' });
          }

          // Create the batch (primary rail stored at batch level for display).
          const batch = await tx.$queryRaw`
            INSERT INTO payout_batches
              (merchant_id, batch_ref, description, total_amount, total_fee, total_vat,
               fee_rate, total_items, status, rail_id, scheduled_at, created_by, created_at, updated_at)
            VALUES
              (${merchantId}::uuid, ${batchRef}, ${description||null},
               ${totalAmount}, ${totalFee}, ${totalVat}, ${feeRate}::decimal,
               ${items.length}, ${batchStatus}, ${primaryRail.rail_id}::uuid,
               ${scheduledAt}, ${req.user.id}::uuid, NOW(), NOW())
            RETURNING id`;
          batchId = batch[0].id;

          // POOLED debit — draw totalDeduction across the merchant's rows (largest first).
          let remaining = totalDeduction;
          for (const w of walletRows) {
            if (remaining <= 0n) break;
            const take = BigInt(w.balance) < remaining ? BigInt(w.balance) : remaining;
            await tx.$executeRaw`UPDATE merchant_wallets SET balance = balance - ${take}, last_used_at = NOW(), updated_at = NOW() WHERE id = ${w.id}::uuid`;
            remaining -= take;
          }
          if (remaining > 0n) throw Object.assign(new Error('Balance changed during processing — please retry'), { _client: true });

          // Ledger (DEBIT beneficiary / FEE / VAT) against the pooled balance, tagged
          // with the primary route rail for reporting.
          const afterBenef = pooled - totalAmount;
          const afterFee   = afterBenef - totalFee;
          const afterAll   = afterFee - totalVat;
          const railLabel  = routeRails.length > 1
            ? routeRails.map(r => `${r.rail_name}(${r.pct}%)`).join('+')
            : primaryRail.rail_name;
          await tx.$executeRaw`
            INSERT INTO wallet_ledger
              (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
            VALUES
              (${merchantId}::uuid, ${primaryRail.rail_id}::uuid, 'DEBIT', ${totalAmount}, ${pooled}, ${afterBenef}, ${batchRef},
               ${'Payout via ' + railLabel + ': ' + (description||batchRef)}, ${req.user.id}::uuid, NOW()),
              (${merchantId}::uuid, ${primaryRail.rail_id}::uuid, 'FEE', ${totalFee}, ${afterBenef}, ${afterFee}, ${batchRef},
               ${'Paylode payout service fee (' + (feeRate*100).toFixed(2) + '%)'}, ${req.user.id}::uuid, NOW()),
              (${merchantId}::uuid, ${primaryRail.rail_id}::uuid, 'VAT', ${totalVat}, ${afterFee}, ${afterAll}, ${batchRef},
               ${'VAT on payout fee (7.5%)'}, ${req.user.id}::uuid, NOW())`;

          // Assign items to rails by weighted block (e.g. 60% → Rail A first, 40% → Rail B).
          // For a single rail, all items get that rail. dispatchBatch already handles multi-rail.
          const railAssignment = (() => {
            if (routeRails.length === 1) return itemsWithFees.map(() => routeRails[0]);
            let pos = 0;
            return itemsWithFees.map((_, i) => {
              const progress = (i + 1) / itemsWithFees.length;
              let cumPct = 0;
              for (const rr of routeRails) {
                cumPct += rr.pct / 100;
                if (progress <= cumPct + 0.0001) return rr;
              }
              return routeRails[routeRails.length - 1];
            });
          })();

          // Insert items, each tagged with its assigned rail.
          for (let idx = 0; idx < itemsWithFees.length; idx++) {
            const item = itemsWithFees[idx];
            const assignedRail = railAssignment[idx];
            const bank = await tx.$queryRaw`SELECT bank_name FROM nigerian_banks WHERE bank_code = ${item.bank_code}`;
            await tx.$executeRaw`
              INSERT INTO payout_items
                (batch_id, merchant_id, account_number, account_name, bank_code, bank_name,
                 amount, item_fee, item_vat, narration, status, rail_id, scheduled_at, created_at)
              VALUES
                (${batchId}::uuid, ${merchantId}::uuid, ${item.account_number}, ${item.account_name||null},
                 ${item.bank_code}, ${bank[0]?.bank_name||item.bank_code},
                 ${BigInt(item.amount)}, ${item.fee}, ${item.vat},
                 ${(item.narration && String(item.narration).trim()) ? item.narration : defaultNarration},
                 ${itemStatus}, ${assignedRail.rail_id}::uuid, ${scheduledAt}, NOW())`;
          }

          walletAfterTotal = afterAll;
        }, { timeout: 30000 });
      } catch (e) {
        if (e && e._client) return fail(res, e.message, e._code || 'RETRY');
        throw e;
      }

      // Response is MERCHANT-facing — never reveal rails or the SA routing queue.
      const isScheduled = scheduledAt && scheduledAt.getTime() > Date.now() + 1000;
      const dispatchesAt = hasRecallWindow ? scheduledAt : (isScheduled ? scheduledAt : null);
      created(res, {
        batch_id:             batchId,
        batch_ref:            batchRef,
        total_payout:         koboToNaira(totalAmount),
        total_fee:            koboToNaira(totalFee),
        total_vat:            koboToNaira(totalVat),
        total_deducted:       koboToNaira(totalDeduction),
        total_items:          items.length,
        status:               hasRecallWindow ? 'pending_review' : (isScheduled ? 'scheduled' : 'processing'),
        dispatches_at:        dispatchesAt,
        recall_until:         hasRecallWindow ? scheduledAt : null,
        scheduled_at:         scheduledAt,
        wallet_balance_after: koboToNaira(walletAfterTotal),
        fee_rate_pct:         (feeRate * 100).toFixed(2) + '%',
      }, hasRecallWindow
        ? `Batch queued — ${items.length} recipients, ₦${koboToNaira(totalAmount).toLocaleString('en-NG')}. Review window: ${recallMinutes} min. Dispatches at ${scheduledAt.toLocaleTimeString('en-NG')}.`
        : `Payout received — ${items.length} beneficiaries, ₦${koboToNaira(totalAmount).toLocaleString('en-NG')} (fee: ₦${koboToNaira(totalFee).toLocaleString('en-NG')})`);

      if (hasRecallWindow) {
        // Pre-fetch NE in background during the review window — dispatch becomes Transfer-only.
        prefetchNEForBatch(batchId).catch(e => logger.warn({ err: e, batchId }, 'NE pre-fetch failed'));
      } else if (!isScheduled) {
        // Funded + rail chosen → fire IMMEDIATELY (async, after the response).
        dispatchBatch({ batchId, actorId: req.user.id, ip: req.ip })
          .catch(e => { if (!e || !e._client) logger.error({ err: e, batchId }, 'immediate payout dispatch failed'); });
      }
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/payouts/batches/upload — CSV/Excel upload ───────────────────
router.post('/batches/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded');

    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');

    const defaultNarration = null; // Narration comes from the merchant; never auto-generated.

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let rows = [];

    if (ext === 'csv') {
      // Parse CSV
      const text = req.file.buffer.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g,''));

      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.trim().replace(/"/g,''));
        const row = {};
        headers.forEach((h,j) => row[h] = vals[j] || '');
        if (row.account_number) rows.push(row);
      }
    } else if (ext === 'xlsx' || ext === 'xls') {
      return fail(res, 'Excel files: please save as CSV first, then upload. CSV format is: account_number, bank_code, amount, narration, account_name (optional)', 'USE_CSV');
    } else {
      return fail(res, 'Only CSV files supported. Format: account_number, bank_code, amount_naira, narration');
    }

    if (rows.length === 0) return fail(res, 'No valid rows found in file');
    if (rows.length > 1000) return fail(res, 'Maximum 1,000 beneficiaries per batch');

    // Validate and transform rows
    const items = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lineNum = i + 2; // 1-indexed + header row

      const acct = (r.account_number || r.accountnumber || r.account || '').replace(/\D/g,'');
      const bank = r.bank_code || r.bankcode || r.bank || '';
      const amtRaw = parseFloat(r.amount || r.amount_naira || r.amountnaira || 0);
      const narration = (r.narration || r.description || r.reference || '').trim() || defaultNarration;
      const name = r.account_name || r.accountname || r.name || '';

      if (acct.length !== 10) { errors.push(`Row ${lineNum}: account_number must be 10 digits`); continue; }
      if (!bank)               { errors.push(`Row ${lineNum}: bank_code is required`); continue; }
      if (isNaN(amtRaw) || amtRaw <= 0) { errors.push(`Row ${lineNum}: invalid amount`); continue; }

      items.push({
        account_number: acct,
        bank_code:      bank,
        amount:         Math.round(amtRaw * 100), // convert naira to kobo
        narration,
        account_name:   name,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        status: false,
        message: `${errors.length} validation error(s) in file`,
        errors: errors.slice(0, 20), // return first 20 errors
        error_code: 'FILE_VALIDATION_ERROR',
      });
    }

    const total = items.reduce((s,i) => s + i.amount, 0);

    ok(res, {
      preview:     items.slice(0, 5),
      total_items: items.length,
      total_amount_naira: total / 100,
      items,
      message: `File parsed successfully. ${items.length} beneficiaries ready. Review and confirm to create batch.`,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/batches — list merchant's payout batches ─────────────
router.get('/batches', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role === 'MERCHANT'
      ? req.user.merchant?.id
      : req.query.merchant_id;

    // Scope to the merchant when one applies (merchants see ONLY their own
    // batches); parameterised to avoid SQL injection. SA/admin (no merchantId)
    // see all. (Was: an unused WHERE string -> every merchant saw all batches.)
    const batches = merchantId
      ? await prisma.$queryRaw`
          SELECT pb.*, m.business_name, pr.name as rail_name
          FROM payout_batches pb
          JOIN merchants m ON pb.merchant_id = m.id
          LEFT JOIN payment_rails pr ON pb.rail_id = pr.id
          WHERE pb.merchant_id = ${merchantId}::uuid
          ORDER BY pb.created_at DESC LIMIT 50`
      : await prisma.$queryRaw`
          SELECT pb.*, m.business_name, pr.name as rail_name
          FROM payout_batches pb
          JOIN merchants m ON pb.merchant_id = m.id
          LEFT JOIN payment_rails pr ON pb.rail_id = pr.id
          ORDER BY pb.created_at DESC LIMIT 50`;

    const isMerchant = req.user.role === 'MERCHANT';
    ok(res, batches.map(b => {
      const out = { ...b, total_amount_naira: koboToNaira(b.total_amount) };
      if (isMerchant) { // rails are internal — never expose to merchants
        delete out.rail_id; delete out.rail_name;
        if (out.status === 'needs_routing') out.status = 'processing';
      }
      return out;
    }));
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/batches/:id — get batch details + items ───────────────
router.get('/batches/:id', requireAuth, async (req, res, next) => {
  try {
    const [batch, items] = await Promise.all([
      prisma.$queryRaw`
        SELECT pb.*, m.business_name, pr.name as rail_name
        FROM payout_batches pb
        JOIN merchants m ON pb.merchant_id = m.id
        LEFT JOIN payment_rails pr ON pb.rail_id = pr.id
        WHERE pb.id = ${req.params.id}::uuid
      `,
      prisma.$queryRaw`
        SELECT * FROM payout_items
        WHERE batch_id = ${req.params.id}::uuid
        ORDER BY created_at ASC
      `,
    ]);

    if (!batch[0]) return notFound(res, 'Payout batch');
    const b = batch[0];
    const isMerchant = req.user.role === 'MERCHANT';
    // Ownership: a merchant may only view their own batch (prevents IDOR).
    if (isMerchant && b.merchant_id !== req.user.merchant?.id)
      return fail(res, 'You can only view your own payout batches', 'FORBIDDEN', 403);
    if (isMerchant) { // rails are internal — never expose to merchants
      delete b.rail_id; delete b.rail_name;
      if (b.status === 'needs_routing') b.status = 'processing';
    }

    ok(res, {
      batch: {
        ...b,
        total_amount_naira:    koboToNaira(b.total_amount),
        total_fee_naira:       koboToNaira(b.total_fee    || 0),
        total_vat_naira:       koboToNaira(b.total_vat    || 0),
        total_deducted_naira:  koboToNaira((b.total_amount || 0n) + (b.total_fee || 0n) + (b.total_vat || 0n)),
        fee_rate_pct:          b.fee_rate ? (Number(b.fee_rate) * 100).toFixed(2) + '%' : '0%',
      },
      items: items.map(i => ({
        ...i,
        amount_naira:   koboToNaira(i.amount),
        fee_naira:      koboToNaira(i.item_fee || 0),
        vat_naira:      koboToNaira(i.item_vat || 0),
        total_deducted: koboToNaira((i.amount || 0n) + (i.item_fee || 0n) + (i.item_vat || 0n)),
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/batches/:id/report — per-batch report with breakdown ──
// Categorises each item: success / failed / ne_failed / sent / reversed / queued.
// Includes failure reasons + rail-level timestamps. SA sees rail detail; merchant sees item-level only.
router.get('/batches/:id/report', requireAuth, async (req, res, next) => {
  try {
    const isMerchant = req.user.role === 'MERCHANT';
    const merchantId = isMerchant ? req.user.merchant?.id : null;

    const [batchRows, items] = await Promise.all([
      prisma.$queryRaw`
        SELECT pb.id, pb.merchant_id, pb.batch_ref, pb.description, pb.status,
               pb.total_amount, pb.total_fee, pb.total_vat, pb.total_items,
               pb.fee_rate, pb.scheduled_at, pb.created_at,
               m.business_name, pr.name AS rail_name
        FROM payout_batches pb
        JOIN merchants m ON pb.merchant_id = m.id
        LEFT JOIN payment_rails pr ON pb.rail_id = pr.id
        WHERE pb.id = ${req.params.id}::uuid`,
      prisma.$queryRaw`
        SELECT pi.id, pi.account_number, pi.account_name, pi.bank_code, pi.bank_name,
               pi.amount, pi.item_fee, pi.item_vat, pi.status, pi.failure_reason,
               pi.provider_ref, pi.narration, pi.created_at,
               rd.rail_order_id, rd.rail_order_no, rd.status AS leg_status,
               rd.error_msg, rd.sent_at, rd.settled_at, rd.rail_cost, rd.rail_vat
        FROM payout_items pi
        LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
        WHERE pi.batch_id = ${req.params.id}::uuid
        ORDER BY pi.status, pi.created_at`,
    ]);

    if (!batchRows[0]) return notFound(res, 'Payout batch');
    const batch = batchRows[0];
    if (isMerchant && batch.merchant_id !== merchantId)
      return fail(res, 'You can only view your own payout batches', 'FORBIDDEN', 403);

    // Categorise items
    const byCategory = { success: [], failed: [], ne_failed: [], sent: [], reversed: [], queued: [] };
    const failureReasons = {};
    for (const row of items) {
      let cat = row.status || 'queued';
      if (cat === 'failed' && /name enquiry/i.test(row.failure_reason || '')) cat = 'ne_failed';
      if (!byCategory[cat]) byCategory[cat] = [];

      const itm = {
        id: row.id,
        account_number: row.account_number,
        account_name:   row.account_name,
        bank_code:      row.bank_code,
        bank_name:      row.bank_name,
        amount_naira:   koboToNaira(row.amount),
        fee_naira:      koboToNaira(row.item_fee || 0),
        status:         row.status,
        failure_reason: row.failure_reason || null,
        provider_ref:   row.provider_ref   || null,
        sent_at:        row.sent_at        || null,
        settled_at:     row.settled_at     || null,
      };
      if (!isMerchant) {
        itm.rail_order_id  = row.rail_order_id  || null;
        itm.rail_order_no  = row.rail_order_no   || null;
        itm.leg_status     = row.leg_status       || null;
        itm.error_msg      = row.error_msg        || null;
        itm.rail_cost_naira = row.rail_cost ? koboToNaira(row.rail_cost) : null;
      }

      byCategory[cat].push(itm);
      if (row.failure_reason) {
        const k = row.failure_reason.substring(0, 80);
        failureReasons[k] = (failureReasons[k] || 0) + 1;
      }
    }

    const summary = {};
    let totalSuccess = 0n, totalFailed = 0n;
    for (const [cat, list] of Object.entries(byCategory)) {
      const koboSum = list.reduce((s, i) => s + BigInt(Math.round(Number(i.amount_naira) * 100)), 0n);
      summary[cat] = { count: list.length, total_naira: koboToNaira(koboSum) };
      if (cat === 'success') totalSuccess = koboSum;
      else totalFailed += koboSum;
    }

    ok(res, {
      batch: {
        id:             batch.id,
        batch_ref:      batch.batch_ref,
        description:    batch.description,
        status:         isMerchant && batch.status === 'needs_routing' ? 'processing' : batch.status,
        scheduled_at:   batch.scheduled_at,
        created_at:     batch.created_at,
        business_name:  batch.business_name,
        rail_name:      isMerchant ? undefined : batch.rail_name,
        total_items:    batch.total_items,
        total_amount_naira: koboToNaira(batch.total_amount),
        total_fee_naira:    koboToNaira(batch.total_fee || 0),
        total_vat_naira:    koboToNaira(batch.total_vat || 0),
      },
      summary,
      failure_reasons: Object.entries(failureReasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count })),
      items: byCategory,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/batches/:id/report.csv — CSV download ─────────────────
router.get('/batches/:id/report.csv', requireAuth, async (req, res, next) => {
  try {
    const isMerchant = req.user.role === 'MERCHANT';
    const merchantId = isMerchant ? req.user.merchant?.id : null;

    const [batchRows, items] = await Promise.all([
      prisma.$queryRaw`SELECT id, merchant_id, batch_ref FROM payout_batches WHERE id = ${req.params.id}::uuid`,
      prisma.$queryRaw`
        SELECT pi.account_number, pi.account_name, pi.bank_code, pi.bank_name,
               pi.amount, pi.item_fee, pi.item_vat, pi.status, pi.failure_reason,
               pi.provider_ref, pi.narration, pi.created_at,
               rd.rail_order_id, rd.sent_at, rd.settled_at, rd.error_msg
        FROM payout_items pi
        LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
        WHERE pi.batch_id = ${req.params.id}::uuid
        ORDER BY pi.status, pi.created_at`,
    ]);

    if (!batchRows[0]) return notFound(res, 'Payout batch');
    if (isMerchant && batchRows[0].merchant_id !== merchantId)
      return fail(res, 'Forbidden', 'FORBIDDEN', 403);

    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const headers = isMerchant
      ? ['account_number', 'account_name', 'bank_code', 'bank_name', 'amount_naira', 'fee_naira', 'status', 'failure_reason', 'provider_ref', 'sent_at', 'settled_at', 'narration']
      : ['account_number', 'account_name', 'bank_code', 'bank_name', 'amount_naira', 'fee_naira', 'status', 'failure_reason', 'provider_ref', 'rail_order_id', 'sent_at', 'settled_at', 'error_msg', 'narration'];

    const rows = [headers.join(',')];
    for (const i of items) {
      const cols = isMerchant
        ? [i.account_number, i.account_name, i.bank_code, i.bank_name, koboToNaira(i.amount), koboToNaira(i.item_fee || 0), i.status, i.failure_reason, i.provider_ref, i.sent_at, i.settled_at, i.narration]
        : [i.account_number, i.account_name, i.bank_code, i.bank_name, koboToNaira(i.amount), koboToNaira(i.item_fee || 0), i.status, i.failure_reason, i.provider_ref, i.rail_order_id, i.sent_at, i.settled_at, i.error_msg, i.narration];
      rows.push(cols.map(esc).join(','));
    }

    const ref = batchRows[0].batch_ref || req.params.id;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payout-${ref}.csv"`);
    res.send(rows.join('\n'));
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/items/:id/status — live status query for one payout item ──
// Returns stored DB status + live rail query if the item is still 'sent'.
router.get('/items/:id/status', requireAuth, async (req, res, next) => {
  try {
    const isMerchant = req.user.role === 'MERCHANT';
    const merchantId = isMerchant ? req.user.merchant?.id : null;

    const rows = await prisma.$queryRaw`
      SELECT pi.id, pi.merchant_id, pi.batch_id, pi.account_number, pi.account_name,
             pi.bank_code, pi.bank_name, pi.amount, pi.status, pi.failure_reason, pi.provider_ref,
             rd.id AS leg_id, rd.rail_order_id, rd.rail_order_no, rd.status AS leg_status,
             rd.error_msg, rd.sent_at, rd.settled_at,
             pr.name AS rail_name
      FROM payout_items pi
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      LEFT JOIN payment_rails pr ON rd.rail_id = pr.id
      WHERE pi.id = ${req.params.id}::uuid`;

    if (!rows[0]) return notFound(res, 'Payout item');
    const row = rows[0];
    if (isMerchant && row.merchant_id !== merchantId)
      return fail(res, 'Forbidden', 'FORBIDDEN', 403);

    let liveStatus = null;
    // If still 'sent', query the rail live
    if (row.leg_status === 'sent' && row.rail_order_id && row.rail_name) {
      try {
        const { payoutAdapterForName } = require('../services/payoutRailAdapter');
        const adapter = payoutAdapterForName(row.rail_name);
        if (adapter && adapter.queryPayoutResult) {
          const r = await adapter.queryPayoutResult({
            orderId:       row.rail_order_id,
            amount:        row.amount,
            accountNumber: row.account_number,
            bankCode:      row.bank_code,
          });
          liveStatus = { code: r.code, reason: r.reason, orderStatus: r.orderStatus };
          // If the live result is conclusive, apply it now
          if (r.orderStatus === '2' || (r.orderStatus !== '1' && r.orderStatus !== '0')) {
            const { applyPayoutResult } = require('../services/payoutSettle');
            await applyPayoutResult({
              orderId: row.rail_order_id, orderNo: null,
              orderStatus: r.orderStatus, errorMsg: r.reason,
              source: 'merchant_query',
            }).catch(() => {});
          }
        }
      } catch (_) {}
    }

    ok(res, {
      id:             row.id,
      status:         row.status,
      leg_status:     isMerchant ? undefined : row.leg_status,
      amount_naira:   koboToNaira(row.amount),
      account_number: row.account_number,
      account_name:   row.account_name,
      bank_name:      row.bank_name,
      failure_reason: row.failure_reason || null,
      provider_ref:   row.provider_ref   || null,
      rail_order_id:  isMerchant ? undefined : row.rail_order_id,
      sent_at:        row.sent_at        || null,
      settled_at:     row.settled_at     || null,
      live_rail_query: liveStatus,
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/batches/:id/retry-failed — retry failed items ────────
router.post('/batches/:id/retry-failed', requireAuth, async (req, res, next) => {
  try {
    const result = await prisma.$executeRaw`
      UPDATE payout_items
      SET status = 'queued', failure_reason = NULL
      WHERE batch_id = ${req.params.id}::uuid AND status = 'failed'
    `;

    ok(res, { retried: Number(result), message: 'Failed items requeued for processing' });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/wallets — SA: per-merchant total + per-rail split ─
// Merchants hold one balance PER RAIL (pre-funded). SA sees the total AND the
// per-rail breakdown (needed for funding + rebalance). Merchants only ever see the
// single total (GET /payouts/wallet).
router.get('/admin/wallets', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    // Every ACTIVATED merchant appears here so SA can fund any of them (even a brand-new
    // merchant with no wallet yet). Deactivated / suspended merchants (isActive=false)
    // drop off. Wallet balances (per rail) are zero until first funded.
    const merchants = await prisma.merchant.findMany({
      where: { isActive: true },
      select: { id: true, businessName: true, merchantCode: true },
    });
    const wallets = await prisma.merchantWallet.findMany({
      include: { rail: { select: { id: true, name: true } } },
    });
    const byMerchant = new Map();
    for (const mm of merchants) {
      byMerchant.set(mm.id, { merchant_id: mm.id, business_name: mm.businessName,
        merchant_code: mm.merchantCode, total: 0n, rails: [], last_funded_at: null, last_used_at: null });
    }
    for (const w of wallets) {
      const m = byMerchant.get(w.merchantId);
      if (!m) continue; // wallet belongs to a non-active merchant → skip
      m.total += w.balance;
      if (w.railId) m.rails.push({ rail_id: w.railId, rail_name: w.rail ? w.rail.name : 'rail',
        balance: Number(w.balance), balance_naira: koboToNaira(w.balance) });
      if (w.lastFundedAt && (!m.last_funded_at || w.lastFundedAt > m.last_funded_at)) m.last_funded_at = w.lastFundedAt;
      if (w.lastUsedAt && (!m.last_used_at || w.lastUsedAt > m.last_used_at)) m.last_used_at = w.lastUsedAt;
    }
    const out = [...byMerchant.values()].map(m => ({
      ...m, total: Number(m.total), total_naira: koboToNaira(m.total),
      balance: Number(m.total), balance_naira: koboToNaira(m.total),
    })).sort((a, b) => b.total - a.total);
    ok(res, out);
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/payout-rails — SA: rails + payout flag + OUR float ─
router.get('/admin/payout-rails', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({
      select: { id: true, name: true, status: true, payoutEnabled: true, floatBalance: true, floatSyncedAt: true,
                payoutFlatCost: true, payoutFlatCostOnUs: true, dailyValueCap: true, tpsLimit: true, sponsorBank: true },
      orderBy: { name: 'asc' },
    });
    // today's value already routed through each rail (for cap headroom display)
    const usedRows = await prisma.$queryRaw`
      SELECT rail_id, COALESCE(SUM(amount),0) AS used
      FROM rail_disbursements
      WHERE created_at >= date_trunc('day', NOW()) AND status NOT IN ('failed','reversed')
      GROUP BY rail_id`;
    const usedBy = {}; usedRows.forEach(r => { usedBy[r.rail_id] = BigInt(r.used); });
    ok(res, rails.map(r => ({
      id: r.id, name: r.name, status: r.status, payoutEnabled: r.payoutEnabled,
      float_balance: Number(r.floatBalance), float_naira: koboToNaira(r.floatBalance), float_synced_at: r.floatSyncedAt,
      payout_flat_cost: Number(r.payoutFlatCost), payout_flat_cost_naira: koboToNaira(r.payoutFlatCost),
      payout_flat_cost_onus: Number(r.payoutFlatCostOnUs), payout_flat_cost_onus_naira: koboToNaira(r.payoutFlatCostOnUs),
      daily_value_cap: r.dailyValueCap != null ? Number(r.dailyValueCap) : null,
      daily_value_cap_naira: r.dailyValueCap != null ? koboToNaira(r.dailyValueCap) : null,
      used_today: Number(usedBy[r.id] || 0n), used_today_naira: koboToNaira(usedBy[r.id] || 0n),
      tps_limit: r.tpsLimit, sponsor_bank: r.sponsorBank,
    })));
  } catch (e) { next(e); }
});

// ── MERCHANT ROUTING (SA) ─────────────────────────────────────────────────────
// Two-tier payout route: ONE global default rail for all merchants, plus an
// optional per-merchant override. SA sets a merchant's route each time they fund;
// null override → the global default. SA may pick ANY live rail. This layer is
// CONFIG ONLY — it records the intended route; disbursement wiring is separate.

// GET — every active merchant with its funded rail(s), current route, plus the
// global default + the list of LIVE rails available to route to.
router.get('/admin/merchant-routing', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const liveRails = await prisma.paymentRail.findMany({
      where: { status: 'LIVE', payoutEnabled: true },
      select: { id: true, name: true, isDefaultPayout: true },
      orderBy: { name: 'asc' },
    });
    const defaultRail = liveRails.find(r => r.isDefaultPayout) || null;

    // Per-merchant: current route + which rails they have funded (balance > 0).
    const rows = await prisma.$queryRawUnsafe(`
      SELECT m.id::text AS merchant_id, m.business_name, m.merchant_code,
             m.payout_rail_id::text AS route_rail_id, pr.name AS route_rail_name,
             COALESCE((
               SELECT string_agg(r2.name || ' (₦' || to_char(w.balance/100.0,'FM999,999,990.00') || ')', ', ' ORDER BY r2.name)
               FROM merchant_wallets w JOIN payment_rails r2 ON w.rail_id = r2.id
               WHERE w.merchant_id = m.id AND w.balance > 0
             ), '') AS funded_rails
      FROM merchants m
      LEFT JOIN payment_rails pr ON m.payout_rail_id = pr.id
      WHERE m.is_active = true
      ORDER BY m.business_name ASC`);

    const merchants = rows.map(r => ({
      merchant_id: r.merchant_id, business_name: r.business_name, merchant_code: r.merchant_code,
      route_rail_id: r.route_rail_id,                                   // null = uses default
      route_rail_name: r.route_rail_name || (defaultRail ? defaultRail.name + ' (default)' : '— none —'),
      uses_default: !r.route_rail_id,
      funded_rails: r.funded_rails || '',
    }));

    ok(res, {
      default_rail: defaultRail ? { id: defaultRail.id, name: defaultRail.name } : null,
      live_rails: liveRails.map(r => ({ id: r.id, name: r.name })),
      merchants,
    });
  } catch (e) { next(e); }
});

// PUT — set/clear ONE merchant's route. body { rail_id } — any LIVE rail, or null
// (clears the override so the merchant falls back to the global default).
router.put('/admin/merchant-routing/:merchantId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { rail_id } = req.body || {};
    const m = await prisma.merchant.findUnique({ where: { id: req.params.merchantId }, select: { id: true } });
    if (!m) return notFound(res, 'Merchant');
    if (rail_id) {
      const rail = await prisma.paymentRail.findUnique({ where: { id: rail_id }, select: { id: true, name: true, status: true, payoutEnabled: true } });
      if (!rail) return notFound(res, 'Rail');
      if (rail.status !== 'LIVE' || !rail.payoutEnabled) return fail(res, `${rail.name} is not a live payout rail`, 'RAIL_NOT_LIVE');
    }
    await prisma.merchant.update({ where: { id: m.id }, data: { payoutRailId: rail_id || null } });
    ok(res, { merchant_id: m.id, rail_id: rail_id || null }, rail_id ? 'Merchant route updated' : 'Merchant route reset to default');
  } catch (e) { next(e); }
});

// PUT — change the GLOBAL default route for all merchants. body { rail_id } — any
// LIVE rail. Flips the single is_default_payout flag atomically.
router.put('/admin/default-rail', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { rail_id } = req.body || {};
    if (!rail_id) return fail(res, 'A rail is required', 'RAIL_REQUIRED');
    const rail = await prisma.paymentRail.findUnique({ where: { id: rail_id }, select: { id: true, name: true, status: true, payoutEnabled: true } });
    if (!rail) return notFound(res, 'Rail');
    if (rail.status !== 'LIVE' || !rail.payoutEnabled) return fail(res, `${rail.name} is not a live payout rail`, 'RAIL_NOT_LIVE');
    await prisma.$transaction([
      prisma.paymentRail.updateMany({ where: { isDefaultPayout: true }, data: { isDefaultPayout: false } }),
      prisma.paymentRail.update({ where: { id: rail_id }, data: { isDefaultPayout: true } }),
    ]);
    ok(res, { rail_id, name: rail.name }, `Default payout route set to ${rail.name}`);
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/provision-va/:merchantId — SA provisions a VA ─────
// Parallex: creates a TIMED VA (amount + reference required in body; not stored in
//   merchant_virtual_accounts since it's per-session/ephemeral). Returns VA number.
// PalmPay: creates a permanent label VA (stored in merchant_virtual_accounts).
//   Idempotent for PalmPay — returns existing row if already provisioned.
// Body: { amount_kobo, reference, expiry_minutes } (Parallex only).
//   Optional { rail_id } overrides merchant's payin rail for this call.
const PARALLEX_RAIL_ID = '8fbc8c22-daba-4fcb-98ee-33ce7d8ffc74';
router.post('/admin/provision-va/:merchantId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { merchantId } = req.params;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT m.id::text, m.business_name, m.business_email, m.parallex_va_name_format,
             m.payin_rail_id::text AS payin_rail_id, pr.name AS payin_rail_name
      FROM merchants m
      LEFT JOIN payment_rails pr ON m.payin_rail_id = pr.id
      WHERE m.id = $1::uuid LIMIT 1`, merchantId);
    if (!rows.length) return notFound(res, 'Merchant');
    const merch = rows[0];

    const railId = (req.body && req.body.rail_id) || merch.payin_rail_id || PARALLEX_RAIL_ID;

    if (railId === PARALLEX_RAIL_ID) {
      // Parallex uses timed (per-session) VAs — amount + reference required each time.
      const { amount_kobo, reference, expiry_minutes } = req.body || {};
      if (!amount_kobo || !reference)
        return fail(res, 'Parallex VA requires amount_kobo and reference in body', 'MISSING_PARAMS');
      if (String(reference).length < 20)
        return fail(res, 'reference must be at least 20 characters (Parallex requirement)', 'REF_TOO_SHORT');
      const plx  = require('../services/parallexService');
      const name  = (merch.parallex_va_name_format || merch.business_name).trim();
      const parts = name.split(/\s+/);
      const r = await plx.createTimedAccount({
        firstName: parts[0],
        lastName: parts.length > 1 ? parts.slice(1).join(' ') : parts[0],
        amountKobo: Number(amount_kobo),
        referenceId: String(reference),
        expiryMinutes: expiry_minutes ? Number(expiry_minutes) : undefined,
      });
      if (!r.ok) return fail(res, `Parallex VA failed: ${r.reason}`, 'VA_PROVISION_FAILED');
      await logAudit(req.user.id, 'VA_PROVISIONED', 'merchant_virtual_accounts', merchantId,
        {}, { provider: 'parallex', va_number: r.accountNumber, reference }, null, req.ip);
      return ok(res, {
        va_number: r.accountNumber, va_name: r.accountName || name,
        bank_name: 'Parallex Bank', provider: 'parallex',
        expiry: r.expiryDateTime, total_amount: r.totalAmount,
      }, 'Parallex timed virtual account created');
    }

    // PalmPay VA — idempotent (label VA is permanent, stored per merchant)
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id::text, va_number, va_name, bank_name, provider, status
       FROM merchant_virtual_accounts WHERE merchant_id = $1::uuid LIMIT 1`, merchantId);
    if (existing.length) return ok(res, existing[0], 'Virtual account already provisioned');

    // Requires approved CAC data
    const kyc = await prisma.$queryRawUnsafe(
      `SELECT cac_data FROM kyc_submissions WHERE merchant_id = $1::uuid AND status = 'APPROVED' LIMIT 1`, merchantId);
    if (!kyc.length || !kyc[0].cac_data)
      return fail(res, 'PalmPay VA requires approved CAC data from KYC', 'KYC_REQUIRED');
    const cac = kyc[0].cac_data;
    const rcNumber = cac.rcNumber || cac.rc_number || cac.registrationNumber;
    if (!rcNumber) return fail(res, 'RC/BN number not found in KYC CAC data', 'KYC_RC_MISSING');
    const palmpay = require('../services/palmpayService');
    const ref     = 'PLY-' + merchantId.replace(/-/g, '').slice(0, 16);
    const vr = await palmpay.createVirtualAccount({
      virtualAccountName: merch.business_name.slice(0, 64),
      identityType: 'company', licenseNumber: rcNumber,
      customerName: merch.business_name, email: merch.business_email, accountReference: ref,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO merchant_virtual_accounts (merchant_id, va_number, va_name, account_reference, bank_name, provider, status, raw)
       VALUES ($1::uuid, $2, $3, $4, 'PalmPay', 'palmpay', 'active', $5::jsonb)`,
      merchantId, vr.virtualAccountNo, vr.virtualAccountName || merch.business_name, ref, JSON.stringify(vr));
    await logAudit(req.user.id, 'VA_PROVISIONED', 'merchant_virtual_accounts', merchantId,
      {}, { provider: 'palmpay', va_number: vr.virtualAccountNo }, null, req.ip);
    return ok(res,
      { va_number: vr.virtualAccountNo, va_name: vr.virtualAccountName || merch.business_name, bank_name: 'PalmPay', provider: 'palmpay' },
      'PalmPay virtual account provisioned');
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/rails/:id/sync-float — SA refreshes OUR balance ─
// Pulls the live balance from the rail's API (if its adapter exposes getBalance)
// and stores it as the rail float. Internal-only.
router.post('/admin/rails/:id/sync-float', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rail = await prisma.paymentRail.findUnique({ where: { id: req.params.id } });
    if (!rail) return notFound(res, 'Rail');
    const kobo = await syncRailFloat(rail);
    if (kobo === null) return fail(res, `${rail.name} does not expose a balance API yet`);
    ok(res, { rail_id: rail.id, name: rail.name, float_balance: Number(kobo), float_naira: koboToNaira(kobo) },
      `${rail.name} float updated to ₦${koboToNaira(kobo).toLocaleString('en-NG')}`);
  } catch (e) { next(e); }
});

// ── PUT /api/v1/payouts/admin/payout-rails/:id — SA toggles payout-enable/status ─
router.put('/admin/payout-rails/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { payout_enabled, status, payout_flat_cost, payout_flat_cost_onus, daily_value_cap, tps_limit, sponsor_bank } = req.body;
    const data = {};
    if (payout_enabled !== undefined) data.payoutEnabled = !!payout_enabled;
    if (status !== undefined)         data.status = status;
    // Config (kobo for money fields). daily_value_cap = null clears the cap.
    if (payout_flat_cost !== undefined) data.payoutFlatCost = BigInt(Math.max(0, Math.round(Number(payout_flat_cost))));
    if (payout_flat_cost_onus !== undefined) data.payoutFlatCostOnUs = BigInt(Math.max(0, Math.round(Number(payout_flat_cost_onus))));
    if (daily_value_cap !== undefined)  data.dailyValueCap  = (daily_value_cap === null || daily_value_cap === '') ? null : BigInt(Math.max(0, Math.round(Number(daily_value_cap))));
    if (tps_limit !== undefined)        data.tpsLimit       = (tps_limit === null || tps_limit === '') ? null : parseInt(tps_limit, 10);
    if (sponsor_bank !== undefined)     data.sponsorBank    = sponsor_bank || null;
    if (!Object.keys(data).length) return fail(res, 'Nothing to update');
    const rail = await prisma.paymentRail.update({ where: { id: req.params.id }, data });
    await logAudit(req.user.id, 'PAYOUT_RAIL_UPDATED', 'payment_rails', rail.id, {}, data, null, req.ip);
    ok(res, { id: rail.id, name: rail.name, status: rail.status, payoutEnabled: rail.payoutEnabled }, 'Rail updated');
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/rail-incident-test — SA verifies rail alerting ─
// Sends a test rail-incident alert email to OPS so we can confirm the failure-
// notification path works before any rail is integrated.
router.post('/admin/rail-incident-test', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rail = await prisma.paymentRail.findFirst({ where: { id: req.body.rail_id || undefined } })
      || { id: 'test', name: req.body.rail_name || 'Test Rail' };
    const sent = await notifyRailIncident(rail, req.body.reason || 'Test alert from SA dashboard',
      { kind: 'test', force: true });
    ok(res, { sent }, sent ? 'Test rail alert sent to ops inbox' : 'Alert suppressed (debounced)');
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/routing-queue — SA: batches awaiting rail routing ─
router.get('/admin/routing-queue', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT pb.id, pb.batch_ref, pb.total_amount, pb.total_fee, pb.total_vat,
             pb.total_items, pb.created_at, pb.rail_id AS route_rail_id, rr.name AS route_rail_name,
             m.id AS merchant_id, m.business_name, m.merchant_code
      FROM payout_batches pb
      JOIN merchants m ON pb.merchant_id = m.id
      LEFT JOIN payment_rails rr ON pb.rail_id = rr.id
      WHERE pb.status = 'needs_routing'
      ORDER BY pb.created_at ASC
    `;
    // OUR rail floats (internal — never merchant-facing). SA allocates the
    // disbursement across these; the merchant balance was already debited.
    const rails = await prisma.paymentRail.findMany({
      where: { payoutEnabled: true },
      select: { id: true, name: true, status: true, floatBalance: true, floatSyncedAt: true },
      orderBy: { name: 'asc' },
    });
    const rail_floats = rails.map(r => ({
      rail_id: r.id, rail_name: r.name, status: r.status,
      balance: Number(r.floatBalance), balance_naira: koboToNaira(r.floatBalance), synced_at: r.floatSyncedAt,
    }));
    const out = rows.map(b => ({
      batch_id: b.id, batch_ref: b.batch_ref, business_name: b.business_name, merchant_code: b.merchant_code,
      // The merchant's ROUTE rail (pre-selected); SA can override per batch on release.
      route_rail_id: b.route_rail_id, route_rail_name: b.route_rail_name,
      // SA allocates against the BENEFICIARY total (what rails actually send).
      total_amount: Number(b.total_amount), total_amount_naira: koboToNaira(b.total_amount),
      total_deduction: Number(b.total_amount) + Number(b.total_fee) + Number(b.total_vat),
      total_deduction_naira: koboToNaira(BigInt(b.total_amount) + BigInt(b.total_fee) + BigInt(b.total_vat)),
      total_items: b.total_items, created_at: b.created_at,
      rail_floats,   // global floats (same list for every batch)
    }));
    ok(res, out);
  } catch (e) { next(e); }
});

// ── Payout dispatch concurrency ───────────────────────────────────────────────
// Two tiers — rail-agnostic, applies to every bank we connect going forward:
//   PREFETCHED (recall window ran NE during review period): 30 concurrent
//   LIVE NE    (dispatch with no pre-fetch):                8 concurrent
// Override via env: PAYOUT_CONCURRENCY_PREFETCHED / PAYOUT_CONCURRENCY
function dispatchConcurrency(hasPrefetchedNE) {
  return hasPrefetchedNE
    ? Number(process.env.PAYOUT_CONCURRENCY_PREFETCHED || 30)
    : Number(process.env.PAYOUT_CONCURRENCY            ||  8);
}
async function runPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── Core payout dispatch — shared by the SA /route endpoint, the immediate auto-
// fire on batch creation, and the scheduled-payout worker. Disburses a
// 'needs_routing' or 'dispatching' batch through its route rail. Returns
// { batch_id, status, settled, pending, failed }, or throws Error with ._client
// for client-facing stops (no float / rail down / cap / unassigned). Never holds
// a DB tx across the external rail call; on a leg failure it refunds float +
// merchant wallet.
async function dispatchBatch({ batchId, overrideRailId = null, actorId = null, ip = null }) {
    const batchRows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid`;
    const batch = batchRows[0];
    if (!batch) throw Object.assign(new Error('Batch not found'), { _client: true, _code: 'NOT_FOUND' });
    if (!['needs_routing', 'dispatching', 'pending_review'].includes(batch.status)) throw Object.assign(new Error(`Batch is not awaiting routing (status: ${batch.status})`), { _client: true });

    // Items carry the merchant's route rail (set at creation). SA may OVERRIDE the
    // rail for this one batch here (per-batch routing): body { rail_id } forces the
    // whole batch through that live rail instead.
    const items = await prisma.$queryRaw`
      SELECT id, amount, bank_code, rail_id, ne_session_id, ne_account_name, ne_fetched_at FROM payout_items
      WHERE batch_id = ${batchId}::uuid AND status = 'queued'
      ORDER BY amount DESC`;
    if (items.some(it => !it.rail_id))
      throw Object.assign(new Error('This batch has unassigned items — it predates rail routing. Recreate the payout.'), { _client: true });
    if (overrideRailId) {
      const orr = await prisma.paymentRail.findUnique({ where: { id: overrideRailId }, select: { id: true, name: true, status: true, payoutEnabled: true } });
      if (!orr) throw Object.assign(new Error('Override rail not found'), { _client: true, _code: 'NOT_FOUND' });
      if (orr.status !== 'LIVE' || !orr.payoutEnabled) throw Object.assign(new Error(`${orr.name} is not a live payout rail`), { _client: true, _code: 'RAIL_NOT_LIVE' });
      items.forEach(it => { it.rail_id = overrideRailId; });   // route the whole batch through the chosen rail
    }
    const byRailId = new Map();
    for (const it of items) {
      const g = byRailId.get(it.rail_id) || { rail_id: it.rail_id, items: [], sum: 0n };
      g.items.push({ id: it.id, amount: BigInt(it.amount), bank_code: it.bank_code });
      g.sum += BigInt(it.amount);
      byRailId.set(it.rail_id, g);
    }
    const used = [...byRailId.values()];

    // Rail config for the assigned rails (cost + cap + payout flag).
    const rails = await prisma.paymentRail.findMany({
      where: { id: { in: used.map(t => t.rail_id) } },
      select: { id: true, name: true, payoutEnabled: true, payoutFlatCost: true, payoutFlatCostOnUs: true, dailyValueCap: true },
    });
    const railById = Object.fromEntries(rails.map(r => [r.id, r]));
    for (const t of used) {
      const r = railById[t.rail_id];
      if (!r || !r.payoutEnabled) throw Object.assign(new Error('A selected rail is not payout-enabled.'), { _client: true, _code: 'RAIL_NOT_LIVE' });
    }

    await prisma.$transaction(async (tx) => {
      for (const t of used) {
        const r = railById[t.rail_id];
        // Daily value cap (sponsor-bank overload guard).
        if (r.dailyValueCap != null) {
          const usedRows = await tx.$queryRaw`
            SELECT COALESCE(SUM(amount),0) AS u FROM rail_disbursements
            WHERE rail_id = ${t.rail_id}::uuid AND created_at >= date_trunc('day', NOW()) AND status NOT IN ('failed','reversed')`;
          if (BigInt(usedRows[0].u) + t.sum > r.dailyValueCap)
            throw Object.assign(new Error(`${r.name} would exceed its daily cap (${koboToNaira(r.dailyValueCap).toLocaleString('en-NG')}).`), { _client: true });
        }
        // The rail takes its fee + VAT from OUR float too, so the float must cover
        // beneficiary amounts PLUS (rail flat cost + 7.5% VAT) per transfer. The rail
        // cost is destination-tiered: on-us (PalmPay) transfers cost less than
        // other-bank transfers, so it's computed PER ITEM by the beneficiary's bank.
        const costForItem = (bankCode) => isOnUsBank(bankCode, r.name) ? r.payoutFlatCostOnUs : r.payoutFlatCost;
        const itemLegs = t.items.map(it => {
          const base = BigInt(costForItem(it.bank_code));
          const vat  = (base * 75n) / 1000n;                 // 7.5% VAT on the flat cost
          return { ...it, railCost: base, railVat: vat };
        });
        const railChargesTotal = itemLegs.reduce((s, l) => s + l.railCost + l.railVat, 0n);
        const floatNeeded      = t.sum + railChargesTotal;   // beneficiary total + rail charges
        // GUARDED float debit — never send more than our balance with the rail.
        const dec = await tx.$queryRaw`
          UPDATE payment_rails SET float_balance = float_balance - ${floatNeeded}, updated_at = NOW()
          WHERE id = ${t.rail_id}::uuid AND float_balance >= ${floatNeeded} RETURNING float_balance`;
        if (!dec.length) throw Object.assign(new Error(
          `${r.name} lacks enough float for ₦${koboToNaira(floatNeeded).toLocaleString('en-NG')} (payout ₦${koboToNaira(t.sum).toLocaleString('en-NG')} + rail fees).`), { _client: true });
        // Write a ledger leg per item (rail_cost = base, rail_vat = VAT on it) + tag the item.
        for (const it of itemLegs) {
          const orderId = `${batch.batch_ref}-${it.id.slice(0, 8)}`;   // unique, ≤32 chars
          await tx.$executeRaw`
            INSERT INTO rail_disbursements
              (payout_item_id, batch_id, merchant_id, rail_id, amount, rail_cost, rail_vat, status, rail_order_id, created_at, updated_at)
            VALUES
              (${it.id}::uuid, ${batchId}::uuid, ${batch.merchant_id}::uuid, ${t.rail_id}::uuid,
               ${it.amount}, ${it.railCost}, ${it.railVat}, 'pending', ${orderId}, NOW(), NOW())`;
          await tx.$executeRaw`UPDATE payout_items SET rail_id = ${t.rail_id}::uuid, status = 'processing' WHERE id = ${it.id}::uuid`;
        }
      }
      await tx.$executeRaw`UPDATE payout_batches SET status = 'processing', rail_id = ${used[0].rail_id}::uuid, updated_at = NOW() WHERE id = ${batchId}::uuid`;
    });

    // ── Disburse each leg through its rail (REAL money) — AFTER the DB tx ─────────
    // Never hold a DB transaction open across an external HTTP call. On failure we
    // refund BOTH our rail float AND the merchant's wallet for that item, and mark
    // the item failed. rail_fee/sessionId are read live from the rail response.
    const { payoutAdapterForName } = require('../services/payoutRailAdapter');
    const { firePayoutWebhook } = require('../services/payoutSettle');
    const railAdapter = (name) => payoutAdapterForName(name);
    const legs = await prisma.$queryRaw`
      SELECT rd.id AS leg_id, rd.rail_id, rd.amount, rd.rail_cost, rd.rail_vat, rd.rail_order_id,
             pi.id AS item_id, pi.account_number, pi.account_name, pi.bank_code, pi.bank_name, pi.narration,
             pi.item_fee, pi.item_vat, pi.ne_session_id, pi.ne_account_name, pi.ne_fetched_at
      FROM rail_disbursements rd JOIN payout_items pi ON rd.payout_item_id = pi.id
      WHERE rd.batch_id = ${batchId}::uuid AND rd.status = 'pending'`;
    // Beneficiary/reference fields for the merchant payout webhook (batch is loaded above).
    const hookLeg = (leg) => ({
      batch_ref: batch.batch_ref, merchant_id: batch.merchant_id, amount: leg.amount,
      account_number: leg.account_number, account_name: leg.account_name,
      bank_code: leg.bank_code, bank_name: leg.bank_name, narration: leg.narration,
    });

    // ── Pipelined NE + Transfer dispatch ─────────────────────────────────────────
    // NE producer (concurrency=10) and transfer consumer run simultaneously.
    // Each completed NE immediately makes the leg available to a transfer worker —
    // no "all NEs first" barrier. Sessions are used within seconds of generation,
    // well within the NIP TTL. Intrabank and non-Parallex legs skip the NE pool.
    const { parallexTransfer: plxAdapter } = (() => {
      try { return { parallexTransfer: require('../services/parallexTransferService') }; } catch (_) { return {}; }
    })();

    let nOk = 0, nFail = 0, nPending = 0;
    const transferQueue = [];   // { leg, nePrefetch }
    let neProducerDone = false;

    const doLeg = async (leg, nePrefetch) => {
      const rail = railById[leg.rail_id];
      const adapter = railAdapter(rail && rail.name);
      let r;
      try {
        if (!adapter || !adapter.isConfigured()) {
          r = { ok: false, reason: 'Rail adapter not configured' };
        } else {
          r = await adapter.sendPayout({
            orderId: leg.rail_order_id, amount: Number(leg.amount), bank_code: leg.bank_code,
            account_number: leg.account_number, account_name: leg.account_name, narration: leg.narration,
            ...nePrefetch,
          });
          // Retry once on NIP throttle (code:90) — fresh call without cached session.
          if (!r.ok && /90|throttl|queue/i.test(String(r.reason || r.code || ''))) {
            await new Promise(res => setTimeout(res, 2000));
            r = await adapter.sendPayout({
              orderId: leg.rail_order_id, amount: Number(leg.amount), bank_code: leg.bank_code,
              account_number: leg.account_number, account_name: leg.account_name, narration: leg.narration,
            });
          }
        }
      } catch (e) { r = { ok: false, reason: e.message }; }

      const os = r.ok ? String(r.orderStatus == null ? '' : r.orderStatus) : null;
      const railFee = (r.raw && r.raw.data && r.raw.data.fee && r.raw.data.fee.fee) || Number(leg.rail_cost);
      const sess = (r.raw && r.raw.data && r.raw.data.sessionId) || null;

      if (r.ok && os === '2') {
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='success', rail_order_no=${r.providerRef || null}, rail_session_id=${sess}, rail_fee=${railFee}, sent_at=NOW(), settled_at=NOW(), updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='success', provider_ref=${r.providerRef || null}, processed_at=NOW() WHERE id=${leg.item_id}::uuid`;
        nOk++;
        await recordRailResult(rail, { ok: true });
        firePayoutWebhook(hookLeg(leg), 'payout.success', { orderNo: r.providerRef, sessionId: sess });
      } else if (r.ok && (os === '' || os === '1' || os === '0')) {
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='sent', rail_order_no=${r.providerRef || null}, rail_session_id=${sess}, rail_fee=${railFee}, sent_at=NOW(), updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='processing', provider_ref=${r.providerRef || null} WHERE id=${leg.item_id}::uuid`;
        nPending++;
        await recordRailResult(rail, { ok: true });
      } else {
        const reason = r.ok ? `Rail returned orderStatus ${os}` : (r.reason || 'failed');
        // Refund amount SA will approve: merchant debit (amount + our fee + our VAT).
        const merchBack = BigInt(leg.amount) + BigInt(leg.item_fee || 0) + BigInt(leg.item_vat || 0);
        // Rail float is restored immediately — we didn't use the rail.
        const floatBack = BigInt(leg.amount) + BigInt(leg.rail_cost || 0) + BigInt(leg.rail_vat || 0);
        await prisma.$executeRaw`UPDATE payment_rails SET float_balance = float_balance + ${floatBack}, updated_at=NOW() WHERE id=${leg.rail_id}::uuid`;
        // Merchant wallet refund is SA-gated — held pending human review.
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='failed', error_msg=${String(reason).slice(0, 280)}, updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='failed', failure_reason=${String(reason).slice(0, 280)}, refund_status='pending_review', refund_amount=${merchBack} WHERE id=${leg.item_id}::uuid`;
        nFail++;
        await recordRailResult(rail, { ok: false, reason, isLowBalance: /insufficient|balance|fund|limit/i.test(String(reason)) },
          { railId: leg.rail_id, railName: rail && rail.name, merchant: batch.merchant_id });
        firePayoutWebhook(hookLeg(leg), 'payout.failed', { orderNo: r.providerRef, sessionId: sess, errorMsg: reason });
      }
    };

    // Mark a leg failed and queue its merchant refund for SA review (same pattern as doLeg failure).
    const pendingRefundLeg = async (leg, reason) => {
      const floatBack = BigInt(leg.amount) + BigInt(leg.rail_cost || 0) + BigInt(leg.rail_vat || 0);
      const merchBack = BigInt(leg.amount) + BigInt(leg.item_fee || 0) + BigInt(leg.item_vat || 0);
      await prisma.$executeRaw`UPDATE payment_rails SET float_balance = float_balance + ${floatBack}, updated_at=NOW() WHERE id=${leg.rail_id}::uuid`;
      await prisma.$executeRaw`UPDATE rail_disbursements SET status='failed', error_msg=${String(reason).slice(0, 280)}, updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
      await prisma.$executeRaw`UPDATE payout_items SET status='failed', failure_reason=${String(reason).slice(0, 280)}, refund_status='pending_review', refund_amount=${merchBack} WHERE id=${leg.item_id}::uuid`;
      nFail++;
      firePayoutWebhook(hookLeg(leg), 'payout.failed', { errorMsg: reason });
    };

    // NE Producer: runs NE for every Parallex interbank leg, pushes to transferQueue.
    // 1. Pre-fetched session (< 60 min old): skip live NE — use cached session directly.
    // 2. Live NE needed: try once; on failure proceed with null session (Option B —
    //    Transfer is the authoritative failure signal, not NE).
    const NE_TTL_MS = 60 * 60 * 1000; // 60 min — proven safe (TTL test 2026-08-30)
    const neProducer = runPool(legs.map(leg => async () => {
      const rail = railById[leg.rail_id];
      const isParallexRail = rail && /parallex/i.test(rail.name || '');
      const isIntra = !leg.bank_code || leg.bank_code === (process.env.PARALLEX_TRANSFER_BANK_CODE || '999015');
      if (!isParallexRail || isIntra || !plxAdapter || !plxAdapter.isConfigured()) {
        transferQueue.push({ leg, nePrefetch: {} });
        return;
      }
      // Use pre-fetched NE session if still fresh.
      const neFetchedAt = leg.ne_fetched_at ? new Date(leg.ne_fetched_at).getTime() : 0;
      if (neFetchedAt && (Date.now() - neFetchedAt) < NE_TTL_MS && leg.ne_session_id) {
        transferQueue.push({ leg, nePrefetch: { neSessionId: leg.ne_session_id, neAccountName: leg.ne_account_name || '', neKycLevel: '' } });
        return;
      }
      // Live NE — Option B: proceed to Transfer even if NE fails.
      const ne = await plxAdapter.nameEnquiry(leg.bank_code, leg.account_number).catch(() => ({ ok: false, reason: 'NE threw' }));
      transferQueue.push({ leg, nePrefetch: ne.ok && ne.sessionId
        ? { neSessionId: ne.sessionId, neAccountName: ne.accountName, neKycLevel: ne.kycLevel || '' }
        : {} });
    }), Number(process.env.PARALLEX_NE_CONCURRENCY || 10)).then(() => { neProducerDone = true; });

    // Transfer consumer: 30 concurrent when NE pre-fetched, 8 when live NE.
    const hasPrefetchedNE = legs.some(leg => leg.ne_session_id && leg.ne_fetched_at);
    const concurrency = dispatchConcurrency(hasPrefetchedNE);
    const transferConsumers = Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!neProducerDone || transferQueue.length > 0) {
          if (transferQueue.length === 0) { await new Promise(r => setTimeout(r, 20)); continue; }
          const item = transferQueue.shift();
          if (item) await doLeg(item.leg, item.nePrefetch);
        }
      })
    );

    await Promise.all([neProducer, transferConsumers]);
    // Batch is terminal only once nothing is still in flight; pending → 'processing'.
    const finalStatus = nPending > 0 ? 'processing'
      : nFail === 0 ? 'completed'
      : (nOk > 0 ? 'partially_failed' : 'failed');
    await prisma.$executeRaw`
      UPDATE payout_batches pb SET
        status          = ${finalStatus},
        processed_items = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status='success'),
        failed_items    = (SELECT COUNT(*) FROM payout_items WHERE batch_id = pb.id AND status='failed'),
        updated_at      = NOW()
      WHERE pb.id = ${batchId}::uuid`;

    await logAudit(actorId, 'PAYOUT_BATCH_DISBURSED', 'payout_batches', batchId, {},
      { rails_used: used.length, settled: nOk, pending: nPending, failed: nFail, status: finalStatus, auto: !actorId }, null, ip).catch(() => {});

    // Automatic post-batch reconciliation — runs after every dispatch.
    runBatchRecon(batchId).catch(() => {});

    return { batch_id: batchId, status: finalStatus, settled: nOk, pending: nPending, failed: nFail };
}

// Post-batch reconciliation — runs automatically after every dispatchBatch.
// Logs a WARNING if the accounting doesn't balance so ops can investigate.
async function runBatchRecon(batchId) {
  const items = await prisma.$queryRawUnsafe(`
    SELECT status, refund_status, amount, item_fee, item_vat, refund_amount
    FROM payout_items WHERE batch_id = $1::uuid`, batchId);

  let deducted = 0n, sent = 0n, inFlight = 0n, held = 0n, refunded = 0n, rejected = 0n;
  for (const i of items) {
    const gross = BigInt(i.amount) + BigInt(i.item_fee || 0) + BigInt(i.item_vat || 0);
    deducted += gross;
    if (i.status === 'success') sent += gross;
    else if (i.status === 'processing') inFlight += gross;
    else if (i.status === 'failed') {
      if      (i.refund_status === 'approved')        refunded += BigInt(i.refund_amount || 0);
      else if (i.refund_status === 'rejected')        rejected += BigInt(i.refund_amount || 0);
      else if (i.refund_status === 'pending_review')  held     += BigInt(i.refund_amount || 0);
    }
  }
  const balanced = deducted === sent + inFlight + held + refunded + rejected;
  const summary = { batchId, balanced, deducted: String(deducted), sent: String(sent),
    inFlight: String(inFlight), held: String(held), refunded: String(refunded), rejected: String(rejected) };

  if (!balanced) {
    logger.warn(summary, 'RECON IMBALANCE — payout batch accounting does not balance');
  } else {
    logger.info(summary, 'Batch recon OK');
  }
  return summary;
}

// Auto-fire DUE payouts: dispatch every 'needs_routing' batch whose scheduled_at is
// due (immediate batches carry scheduled_at = creation time). A client-stop (no float
// / rail down / cap) leaves the batch in needs_routing → the merchant/SA exception queue.
async function autoDispatchDuePayouts({ limit = 25 } = {}) {
  // Atomically claim batches as 'dispatching' so concurrent workers can't double-fire.
  const due = await prisma.$queryRaw`
    WITH claimed AS (
      SELECT id FROM payout_batches
      WHERE status IN ('needs_routing', 'pending_review') AND (scheduled_at IS NULL OR scheduled_at <= NOW())
      ORDER BY scheduled_at ASC NULLS FIRST
      LIMIT ${Number(limit)}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE payout_batches SET status = 'dispatching', updated_at = NOW()
    FROM claimed WHERE payout_batches.id = claimed.id
    RETURNING payout_batches.id`;
  let fired = 0, held = 0;
  for (const b of due) {
    try { await dispatchBatch({ batchId: b.id }); fired++; }
    catch (e) { held++; if (!e || !e._client) logger.error({ err: e, batchId: b.id }, 'auto-dispatch payout failed'); }
  }
  return { considered: due.length, fired, held };
}

// ── POST /api/v1/payouts/admin/batches/:id/route — SA manual disburse (exceptions) ─
// Kept for the EXCEPTION queue (batches the auto-dispatcher HELD: rail down / no
// float) and per-batch rail override. Normal payouts auto-fire on creation (see the
// dispatch worker), so SA no longer releases each one.
router.post('/admin/batches/:id/route', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await dispatchBatch({ batchId: req.params.id, overrideRailId: (req.body && req.body.rail_id) || null, actorId: req.user.id, ip: req.ip });
    ok(res, r, `Payout ${r.status} — ${r.settled} settled${r.pending ? `, ${r.pending} processing` : ''}${r.failed ? `, ${r.failed} failed (refunded)` : ''}`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── GET/PUT /api/v1/payouts/admin/merchants/:id/routing — SA routing config ───
// GET: returns current routing (single rail or split percentages).
// PUT: accepts { rail_id } for a single rail override, OR { splits:[{rail_id,pct}] }
// for weighted multi-rail routing. Splits must sum to 100. Pass {} to clear back
// to global default.
router.get('/admin/merchants/:id/routing', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const merchantId = req.params.id;
    const splits = await prisma.merchantPayoutSplit.findMany({
      where: { merchantId, isActive: true },
      include: { rail: { select: { id: true, name: true } } },
      orderBy: { pct: 'desc' },
    });
    if (splits.length > 0) {
      return ok(res, { mode: 'split', splits: splits.map(s => ({ rail_id: s.railId, rail_name: s.rail.name, pct: s.pct })) });
    }
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { payoutRailId: true, payoutRail: { select: { id: true, name: true } } },
    });
    if (!merchant) return fail(res, 'Merchant not found', 'NOT_FOUND');
    if (merchant.payoutRailId) {
      return ok(res, { mode: 'override', rail_id: merchant.payoutRailId, rail_name: merchant.payoutRail?.name });
    }
    const def = await prisma.paymentRail.findFirst({ where: { isDefaultPayout: true }, select: { id: true, name: true } });
    ok(res, { mode: 'default', rail_id: def?.id, rail_name: def?.name });
  } catch (e) { next(e); }
});

router.put('/admin/merchants/:id/routing', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const merchantId = req.params.id;
    const { rail_id, splits } = req.body || {};

    if (splits) {
      // Split mode — validate then upsert.
      if (!Array.isArray(splits) || splits.length < 2)
        return fail(res, 'splits must be an array with at least 2 entries', 'VALIDATION_ERROR');
      const total = splits.reduce((s, r) => s + Number(r.pct || 0), 0);
      if (total !== 100) return fail(res, `Split percentages must sum to 100 (got ${total})`, 'VALIDATION_ERROR');
      await prisma.$transaction(async (tx) => {
        await tx.merchantPayoutSplit.deleteMany({ where: { merchantId } });
        for (const s of splits) {
          await tx.merchantPayoutSplit.create({ data: { merchantId, railId: s.rail_id, pct: Number(s.pct), isActive: true } });
        }
        await tx.merchant.update({ where: { id: merchantId }, data: { payoutRailId: null } });
      });
      return ok(res, { mode: 'split', splits }, 'Routing updated — split mode');
    }

    // Single rail or clear to default.
    await prisma.merchantPayoutSplit.deleteMany({ where: { merchantId } });
    await prisma.merchant.update({ where: { id: merchantId }, data: { payoutRailId: rail_id || null } });
    ok(res, { mode: rail_id ? 'override' : 'default', rail_id: rail_id || null }, rail_id ? 'Routing updated — single rail override' : 'Routing cleared to global default');
  } catch (e) { next(e); }
});

// ── Reverse an un-dispatched (needs_routing) batch — shared by SA cancel + merchant
// self-cancel. REVERSES the full deduction (beneficiary + fee + VAT) to the
// merchant's pooled wallet (route-rail row else largest), REVERSAL ledger entry,
// marks batch + queued items 'reversed'. Never contacts the rail (no float debited
// pre-dispatch). scopeMerchantId (when set) enforces ownership (merchant self-cancel).
async function reverseBatch({ batchId, scopeMerchantId = null, actorId = null, ip = null, by = 'admin' }) {
  const rows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid`;
  const batch = rows[0];
  if (!batch) throw Object.assign(new Error('Batch not found'), { _client: true, _code: 'NOT_FOUND' });
  if (scopeMerchantId && batch.merchant_id !== scopeMerchantId)
    throw Object.assign(new Error('This payout does not belong to your account.'), { _client: true, _code: 'FORBIDDEN' });
  if (!['needs_routing', 'pending_review'].includes(batch.status))
    throw Object.assign(new Error(`Only an un-sent payout (scheduled or awaiting dispatch) can be cancelled — this one is '${batch.status}'.`), { _client: true, _code: 'NOT_CANCELLABLE' });

  const refund = BigInt(batch.total_amount) + BigInt(batch.total_fee) + BigInt(batch.total_vat);
  await prisma.$transaction(async (tx) => {
    const pooledRow = await tx.$queryRaw`SELECT COALESCE(SUM(balance),0) AS b FROM merchant_wallets WHERE merchant_id = ${batch.merchant_id}::uuid`;
    const pooled = BigInt(pooledRow[0].b);
    const upd = await tx.$queryRaw`
      UPDATE merchant_wallets SET balance = balance + ${refund}, updated_at = NOW()
      WHERE id = (SELECT id FROM merchant_wallets WHERE merchant_id = ${batch.merchant_id}::uuid
                  ORDER BY (rail_id = ${batch.rail_id}::uuid) DESC, balance DESC LIMIT 1)
      RETURNING id`;
    if (!upd.length) throw Object.assign(new Error('No wallet to refund into.'), { _client: true });
    await tx.$executeRaw`
      INSERT INTO wallet_ledger
        (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
      VALUES
        (${batch.merchant_id}::uuid, ${batch.rail_id}::uuid, 'REVERSAL', ${refund}, ${pooled}, ${pooled + refund}, ${batch.batch_ref},
         ${'Payout batch ' + batch.batch_ref + ' cancelled — reversed to wallet'}, ${actorId}::uuid, NOW())`;
    await tx.$executeRaw`UPDATE payout_items SET status = 'reversed', failure_reason = ${'Batch cancelled by ' + by} WHERE batch_id = ${batchId}::uuid AND status IN ('queued','pending')`;
    await tx.$executeRaw`UPDATE payout_batches SET status = 'reversed', updated_at = NOW() WHERE id = ${batchId}::uuid`;
  });
  await logAudit(actorId, by === 'merchant' ? 'PAYOUT_BATCH_CANCELLED_BY_MERCHANT' : 'PAYOUT_BATCH_CANCELLED', 'payout_batches', batchId,
    { status: 'needs_routing' }, { status: 'reversed', refunded: Number(refund) }, null, ip).catch(() => {});
  return { batch_id: batchId, status: 'reversed', refunded: Number(refund), refunded_naira: koboToNaira(refund) };
}

// ── POST /api/v1/payouts/admin/batches/:id/cancel — SA cancel a queued batch ──
router.post('/admin/batches/:id/cancel', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const r = await reverseBatch({ batchId: req.params.id, actorId: req.user.id, ip: req.ip, by: 'admin' });
    ok(res, r, `Batch cancelled — ₦${r.refunded_naira.toLocaleString('en-NG')} reversed to the merchant's wallet.`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── GET /api/v1/payouts/queue — MERCHANT: their own pending/scheduled payouts ──
// Shows un-sent payouts (status 'needs_routing') with a merchant-facing reason —
// scheduled (future) or processing (awaiting dispatch). Rails are NEVER exposed.
router.get('/queue', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const rows = await prisma.$queryRaw`
      SELECT id, batch_ref, total_amount, total_fee, total_vat, total_items, status, scheduled_at, created_at
      FROM payout_batches WHERE merchant_id = ${merchantId}::uuid AND status IN ('needs_routing', 'pending_review')
      ORDER BY scheduled_at ASC NULLS FIRST, created_at ASC`;
    const now = Date.now();
    const out = rows.map(b => {
      const isPendingReview = b.status === 'pending_review';
      const dispatchesAt    = b.scheduled_at ? new Date(b.scheduled_at).getTime() : null;
      const isScheduled     = !isPendingReview && dispatchesAt && dispatchesAt > now + 1000;
      const msLeft          = isPendingReview && dispatchesAt ? Math.max(0, dispatchesAt - now) : null;
      return {
        batch_id: b.id, batch_ref: b.batch_ref,
        total_amount:   koboToNaira(b.total_amount),
        total_deducted: koboToNaira(BigInt(b.total_amount) + BigInt(b.total_fee) + BigInt(b.total_vat)),
        total_items: b.total_items, scheduled_at: b.scheduled_at, created_at: b.created_at,
        queue_status: isPendingReview ? 'pending_review' : (isScheduled ? 'scheduled' : 'processing'),
        recall_seconds_left: msLeft != null ? Math.round(msLeft / 1000) : null,
        dispatches_at: b.scheduled_at,
        reason: isPendingReview
          ? `Review window — dispatches at ${new Date(b.scheduled_at).toLocaleTimeString('en-NG')} (${Math.ceil(msLeft/60000)} min left)`
          : (isScheduled
            ? `Scheduled — sends ${new Date(b.scheduled_at).toLocaleString('en-NG')}`
            : 'Processing — will send shortly'),
        cancellable: true,
        recallable:  isPendingReview && msLeft > 0,
        dispatchable: isPendingReview,
      };
    });
    ok(res, out);
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/batches/:id/cancel — MERCHANT: cancel own un-sent payout ──
router.post('/batches/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const r = await reverseBatch({ batchId: req.params.id, scopeMerchantId: merchantId, actorId: req.user.id, ip: req.ip, by: 'merchant' });
    ok(res, r, `Payout cancelled — ₦${r.refunded_naira.toLocaleString('en-NG')} returned to your wallet.`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── POST /api/v1/payouts/batches/:id/recall — MERCHANT: recall during review window ──
router.post('/batches/:id/recall', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const rows = await prisma.$queryRaw`SELECT status, scheduled_at FROM payout_batches WHERE id = ${req.params.id}::uuid AND merchant_id = ${merchantId}::uuid`;
    if (!rows.length) return fail(res, 'Batch not found', 'NOT_FOUND');
    if (rows[0].status !== 'pending_review') return fail(res, `Batch is not in review window (status: ${rows[0].status})`, 'NOT_RECALLABLE');
    if (rows[0].scheduled_at && new Date(rows[0].scheduled_at) <= new Date()) return fail(res, 'Review window has expired — batch already queued for dispatch', 'WINDOW_EXPIRED');
    const r = await reverseBatch({ batchId: req.params.id, scopeMerchantId: merchantId, actorId: req.user.id, ip: req.ip, by: 'merchant' });
    ok(res, r, `Batch recalled — ₦${r.refunded_naira.toLocaleString('en-NG')} returned to your wallet.`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── POST /api/v1/payouts/batches/:id/dispatch-now — MERCHANT: skip review window ──
router.post('/batches/:id/dispatch-now', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const rows = await prisma.$queryRaw`SELECT status, merchant_id FROM payout_batches WHERE id = ${req.params.id}::uuid`;
    if (!rows.length) return fail(res, 'Batch not found', 'NOT_FOUND');
    if (rows[0].merchant_id !== merchantId) return fail(res, 'Forbidden', 'FORBIDDEN');
    if (rows[0].status !== 'pending_review') return fail(res, `Batch is not in review window (status: ${rows[0].status})`, 'NOT_DISPATCHABLE');
    // Move to needs_routing so dispatchBatch accepts it, then fire.
    await prisma.$executeRaw`UPDATE payout_batches SET status = 'needs_routing', updated_at = NOW() WHERE id = ${req.params.id}::uuid`;
    const r = await dispatchBatch({ batchId: req.params.id, actorId: req.user.id, ip: req.ip });
    ok(res, r, `Batch dispatched — ${r.settled} settled${r.pending ? `, ${r.pending} processing` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── DELETE /api/v1/payouts/batches/:id/items/:itemId — MERCHANT: remove item in window ──
router.delete('/batches/:batchId/items/:itemId', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { batchId, itemId } = req.params;
    const bRows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid AND merchant_id = ${merchantId}::uuid`;
    if (!bRows.length) return fail(res, 'Batch not found', 'NOT_FOUND');
    const batch = bRows[0];
    if (batch.status !== 'pending_review') return fail(res, 'Items can only be removed during the review window', 'NOT_RECALLABLE');
    const iRows = await prisma.$queryRaw`SELECT * FROM payout_items WHERE id = ${itemId}::uuid AND batch_id = ${batchId}::uuid AND status = 'queued'`;
    if (!iRows.length) return fail(res, 'Item not found or already dispatched', 'NOT_FOUND');
    const item = iRows[0];
    // Partial refund for this item (amount + fee + vat).
    const refund = BigInt(item.amount) + BigInt(item.item_fee) + BigInt(item.item_vat);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE merchant_wallets SET balance = balance + ${refund}, updated_at = NOW()
        WHERE id = (SELECT id FROM merchant_wallets WHERE merchant_id = ${merchantId}::uuid ORDER BY balance DESC LIMIT 1)`;
      await tx.$executeRaw`DELETE FROM payout_items WHERE id = ${itemId}::uuid`;
      await tx.$executeRaw`
        UPDATE payout_batches SET
          total_amount = total_amount - ${BigInt(item.amount)},
          total_fee    = total_fee    - ${BigInt(item.item_fee)},
          total_vat    = total_vat    - ${BigInt(item.item_vat)},
          total_items  = total_items  - 1,
          updated_at   = NOW()
        WHERE id = ${batchId}::uuid`;
    });
    ok(res, { removed_item_id: itemId, refunded: koboToNaira(refund) }, `Item removed — ₦${koboToNaira(refund).toLocaleString('en-NG')} returned to wallet.`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message, e._code);
    next(e);
  }
});

// ── GET /api/v1/payouts/settings — MERCHANT: get payout preferences ──────────
router.get('/settings', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const rows = await prisma.$queryRawUnsafe(
      'SELECT payout_recall_window_minutes FROM merchants WHERE id = $1::uuid', merchantId);
    ok(res, { recall_window_minutes: Number(rows[0]?.payout_recall_window_minutes || 0) });
  } catch (e) { next(e); }
});

// ── PATCH /api/v1/payouts/settings — MERCHANT: set recall window preference ───
router.patch('/settings', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { recall_window_minutes } = req.body || {};
    const allowed = [0, 15, 30, 60];
    if (!allowed.includes(Number(recall_window_minutes))) return fail(res, `recall_window_minutes must be one of: ${allowed.join(', ')}`, 'INVALID');
    await prisma.$executeRawUnsafe(
      'UPDATE merchants SET payout_recall_window_minutes = $1 WHERE id = $2::uuid', Number(recall_window_minutes), merchantId);
    ok(res, { recall_window_minutes: Number(recall_window_minutes) },
      recall_window_minutes > 0
        ? `Recall window enabled — new batches will have a ${recall_window_minutes}-minute review period before dispatch.`
        : 'Recall window disabled — batches will dispatch immediately.');
  } catch (e) { next(e); }
});

// ── PATCH /api/v1/payouts/admin/merchants/:id/payout-settings — SA per-merchant ──
router.patch('/admin/merchants/:id/payout-settings', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { recall_window_minutes } = req.body || {};
    const allowed = [0, 15, 30, 60];
    if (recall_window_minutes !== undefined && !allowed.includes(Number(recall_window_minutes))) return fail(res, `recall_window_minutes must be one of: ${allowed.join(', ')}`, 'INVALID');
    if (recall_window_minutes !== undefined) {
      await prisma.$executeRawUnsafe(
        'UPDATE merchants SET payout_recall_window_minutes = $1 WHERE id = $2::uuid', Number(recall_window_minutes), req.params.id);
    }
    const rows = await prisma.$queryRawUnsafe(
      'SELECT payout_recall_window_minutes FROM merchants WHERE id = $1::uuid', req.params.id);
    ok(res, { recall_window_minutes: Number(rows[0]?.payout_recall_window_minutes || 0) }, 'Payout settings updated.');
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/refunds/pending — SA: list items pending refund review ──
router.get('/admin/refunds/pending', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const items = await prisma.$queryRawUnsafe(`
      SELECT pi.id, pi.account_number, pi.account_name, pi.bank_code, pi.amount::text,
             pi.failure_reason, pi.refund_amount::text, pi.refund_status, pi.created_at,
             pb.batch_ref, pb.merchant_id,
             m.business_name
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN merchants m ON m.id = pb.merchant_id
      WHERE pi.refund_status = 'pending_review'
      ORDER BY pi.created_at DESC
      LIMIT 200
    `);
    ok(res, items);
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/refunds/:itemId/approve — SA: approve and execute refund ──
router.post('/admin/refunds/:itemId/approve', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const [item] = await prisma.$queryRawUnsafe(`
      SELECT pi.id, pi.refund_amount, pi.refund_status, pi.batch_id,
             pb.merchant_id, rd.rail_id
      FROM payout_items pi
      JOIN payout_batches pb ON pb.id = pi.batch_id
      JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.id = $1::uuid AND pi.refund_status = 'pending_review'
    `, itemId);
    if (!item) return fail(res, 'Item not found or not pending review');

    const merchBack = BigInt(item.refund_amount);
    await prisma.$executeRaw`
      UPDATE merchant_wallets SET balance = balance + ${merchBack}, updated_at = NOW()
      WHERE merchant_id = ${item.merchant_id}::uuid AND rail_id = ${item.rail_id}::uuid`;
    await prisma.$executeRaw`
      UPDATE payout_items SET refund_status = 'approved', refund_reviewed_at = NOW(),
        refund_reviewed_by = ${req.user.email || req.user.id} WHERE id = ${itemId}::uuid`;

    const naira = (Number(item.refund_amount) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
    ok(res, { item_id: itemId, refunded_naira: Number(item.refund_amount) / 100 },
      `Refund of ₦${naira} approved and credited to merchant wallet.`);
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/refunds/:itemId/reject — SA: reject refund (transfer went through) ──
router.post('/admin/refunds/:itemId/reject', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const [item] = await prisma.$queryRawUnsafe(
      `SELECT id FROM payout_items WHERE id = $1::uuid AND refund_status = 'pending_review'`, itemId);
    if (!item) return fail(res, 'Item not found or not pending review');
    const { reason } = req.body || {};
    await prisma.$executeRaw`
      UPDATE payout_items SET refund_status = 'rejected', refund_reviewed_at = NOW(),
        refund_reviewed_by = ${req.user.email || req.user.id},
        failure_reason = COALESCE(${reason || null}, failure_reason)
      WHERE id = ${itemId}::uuid`;
    ok(res, { item_id: itemId }, 'Refund rejected — merchant wallet not credited.');
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/batches/:id/recon — batch reconciliation summary ──────
router.get('/batches/:id/recon', requireAuth, async (req, res, next) => {
  try {
    const isSA = req.user.role === 'SUPER_ADMIN' || req.user.role === 'ADMIN';
    const merchantId = req.user.merchant?.id;
    const [batch] = await prisma.$queryRawUnsafe(
      `SELECT pb.*, m.business_name FROM payout_batches pb
       JOIN merchants m ON m.id = pb.merchant_id
       WHERE pb.id = $1::uuid ${isSA ? '' : 'AND pb.merchant_id = $2::uuid'}`,
      ...(isSA ? [req.params.id] : [req.params.id, merchantId])
    );
    if (!batch) return notFound(res, 'Batch');

    const items = await prisma.$queryRawUnsafe(`
      SELECT status, refund_status, amount::text, item_fee::text, item_vat::text, refund_amount::text
      FROM payout_items WHERE batch_id = $1::uuid
    `, req.params.id);

    let totalDeducted = 0n, totalSent = 0n, totalPending = 0n,
        totalFailedHeld = 0n, totalRefunded = 0n, totalRejected = 0n;
    let countSuccess = 0, countProcessing = 0, countFailed = 0;

    for (const i of items) {
      const gross = BigInt(i.amount) + BigInt(i.item_fee || 0) + BigInt(i.item_vat || 0);
      totalDeducted += gross;
      if (i.status === 'success')     { totalSent += gross; countSuccess++; }
      else if (i.status === 'processing') { totalPending += gross; countProcessing++; }
      else if (i.status === 'failed') {
        countFailed++;
        if (i.refund_status === 'approved') totalRefunded += BigInt(i.refund_amount || 0);
        else if (i.refund_status === 'rejected') totalRejected += BigInt(i.refund_amount || 0);
        else if (i.refund_status === 'pending_review') totalFailedHeld += BigInt(i.refund_amount || 0);
      }
    }

    const [wallet] = await prisma.$queryRawUnsafe(
      `SELECT balance::text FROM merchant_wallets WHERE merchant_id = $1::uuid
       ORDER BY balance DESC LIMIT 1`, batch.merchant_id);

    ok(res, {
      batch_ref:        batch.batch_ref,
      status:           batch.status,
      business_name:    batch.business_name,
      total_items:      items.length,
      count_success:    countSuccess,
      count_processing: countProcessing,
      count_failed:     countFailed,
      total_deducted_kobo:       String(totalDeducted),
      total_sent_kobo:           String(totalSent),
      total_in_flight_kobo:      String(totalPending),
      total_failed_held_kobo:    String(totalFailedHeld),
      total_refunded_kobo:       String(totalRefunded),
      total_rejected_kobo:       String(totalRejected),
      current_wallet_balance_kobo: wallet ? wallet.balance : '0',
      accounting_check: {
        // deducted = sent + in_flight + held_for_review + refunded_back + rejected_kept
        balanced: totalDeducted === totalSent + totalPending + totalFailedHeld + totalRefunded + totalRejected,
      },
    });
  } catch (e) { next(e); }
});

// ── NE pre-fetch: run during the recall window so dispatch is Transfer-only ───
// Throttled to 5 concurrent to stay under the relay's connection ceiling while
// other merchant batches may also be dispatching or pre-fetching simultaneously.
async function prefetchNEForBatch(batchId) {
  const { parallexTransfer: plxAdapter } = (() => {
    try { return { parallexTransfer: require('../services/parallexTransferService') }; } catch (_) { return {}; }
  })();
  if (!plxAdapter || !plxAdapter.isConfigured()) return;

  const BANK_CODE_PARALLEX = process.env.PARALLEX_TRANSFER_BANK_CODE || '999015';
  const items = await prisma.$queryRawUnsafe(
    "SELECT id, bank_code, account_number FROM payout_items WHERE batch_id = $1::uuid AND status = 'queued'", batchId);
  const interbank = items.filter(i => i.bank_code && i.bank_code !== BANK_CODE_PARALLEX);

  // 5 concurrent NE calls during the window — well under DO relay ceiling.
  const CONCURRENCY = 5;
  for (let i = 0; i < interbank.length; i += CONCURRENCY) {
    await Promise.all(interbank.slice(i, i + CONCURRENCY).map(async item => {
      try {
        const ne = await plxAdapter.nameEnquiry(item.bank_code, item.account_number);
        if (ne.ok && ne.sessionId) {
          await prisma.$executeRawUnsafe(
            'UPDATE payout_items SET ne_session_id = $1, ne_account_name = $2, ne_fetched_at = NOW() WHERE id = $3::uuid',
            ne.sessionId, ne.accountName || null, item.id);
        }
      } catch (_) { /* best-effort — NE failure does not block dispatch */ }
    }));
  }
}

// ── GET /api/v1/payouts/logs — payout item logs (merchant sees own, admin sees all) ──
router.get('/logs', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, perPage = 50, status, merchant_id, from, to, batch_ref } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(perPage);

    const isMerchant = req.user.role === 'MERCHANT';
    const targetMerchantId = isMerchant ? req.user.merchant?.id : (merchant_id || null);

    // Build dynamic query
    const conditions = [];
    const params = [];
    let p = 1;

    if (targetMerchantId) { conditions.push(`pi.merchant_id = $${p++}::uuid`); params.push(targetMerchantId); }
    if (status)           { conditions.push(`pi.status = $${p++}`);            params.push(status); }
    if (from)             { conditions.push(`pi.created_at >= $${p++}`);       params.push(new Date(from)); }
    if (to)               { conditions.push(`pi.created_at <= $${p++}`);       params.push(new Date(to + 'T23:59:59Z')); }
    if (batch_ref)        { conditions.push(`pb.batch_ref ILIKE $${p++}`);     params.push('%' + batch_ref + '%'); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [items, countResult] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT pi.*, pb.batch_ref, pb.description as batch_description,
               m.business_name, m.merchant_code,
               pb.fee_rate
        FROM payout_items pi
        JOIN payout_batches pb ON pi.batch_id = pb.id
        JOIN merchants m ON pi.merchant_id = m.id
        ${where}
        ORDER BY pi.created_at DESC
        LIMIT ${parseInt(perPage)} OFFSET ${offset}
      `, ...params),
      prisma.$queryRawUnsafe(`
        SELECT COUNT(*) as total
        FROM payout_items pi
        JOIN payout_batches pb ON pi.batch_id = pb.id
        JOIN merchants m ON pi.merchant_id = m.id
        ${where}
      `, ...params),
    ]);

    const total = Number(countResult[0]?.total || 0);

    ok(res, {
      data: items.map(i => ({
        ...i,
        amount_naira:    koboToNaira(i.amount),
        fee_naira:       koboToNaira(i.item_fee || 0),
        vat_naira:       koboToNaira(i.item_vat || 0),
        total_deducted:  koboToNaira((i.amount || 0n) + (i.item_fee || 0n) + (i.item_vat || 0n)),
        failure_reason:  i.failure_reason || (i.status === 'failed' ? 'Processing failed — contact support' : null),
      })),
      meta: { page: parseInt(page), perPage: parseInt(perPage), total, pages: Math.ceil(total / parseInt(perPage)) },
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/report — super admin payout report ──────────────
router.get('/admin/report', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { from, to, merchant_id } = req.query;
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate   = to   ? new Date(to + 'T23:59:59Z') : new Date();

    const merchantFilter = merchant_id ? `AND pb.merchant_id = '${merchant_id}'::uuid` : '';

    // Summary by merchant
    const byMerchant = await prisma.$queryRawUnsafe(`
      SELECT
        m.id                                                  AS merchant_id,
        m.business_name,
        m.merchant_code,
        COUNT(DISTINCT pb.id)::int                            AS batch_count,
        SUM(pb.total_items)::int                              AS total_items,
        SUM(pb.processed_items)::int                          AS success_items,
        SUM(pb.failed_items)::int                             AS failed_items,
        SUM(pb.total_amount)::bigint                          AS total_amount,
        SUM(pb.total_fee)::bigint                             AS total_fee_earned,
        SUM(pb.total_vat)::bigint                             AS total_vat_collected,
        SUM(pb.total_amount + pb.total_fee + pb.total_vat)::bigint AS total_deducted,
        COALESCE((SELECT SUM(rd.rail_cost - COALESCE(rd.rail_vat,0))
                    FROM rail_disbursements rd
                    JOIN payout_items pi2 ON rd.payout_item_id = pi2.id
                    JOIN payout_batches pb2 ON pi2.batch_id = pb2.id
                   WHERE pb2.merchant_id = m.id AND rd.status = 'success'
                     AND pb2.created_at >= $1 AND pb2.created_at <= $2), 0)::bigint AS rail_cost_net,
        COALESCE((SELECT SUM(pi3.item_fee - COALESCE(pi3.item_vat,0))
                    FROM rail_disbursements rd3
                    JOIN payout_items pi3 ON rd3.payout_item_id = pi3.id
                    JOIN payout_batches pb3 ON pi3.batch_id = pb3.id
                   WHERE pb3.merchant_id = m.id AND rd3.status = 'success'
                     AND pb3.created_at >= $1 AND pb3.created_at <= $2), 0)::bigint AS realized_fee_net
      FROM payout_batches pb
      JOIN merchants m ON pb.merchant_id = m.id
      WHERE pb.created_at >= $1 AND pb.created_at <= $2
        ${merchantFilter}
      GROUP BY m.id, m.business_name, m.merchant_code
      ORDER BY total_fee_earned DESC NULLS LAST
    `, fromDate, toDate);

    // Platform totals
    const totals = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(DISTINCT pb.id)::int                            AS batch_count,
        COUNT(DISTINCT pb.merchant_id)::int                   AS active_merchants,
        SUM(pb.total_items)::int                              AS total_items,
        SUM(pb.processed_items)::int                          AS success_items,
        SUM(pb.failed_items)::int                             AS failed_items,
        SUM(pb.total_amount)::bigint                          AS total_amount,
        SUM(pb.total_fee)::bigint                             AS total_fee_earned,
        SUM(pb.total_vat)::bigint                             AS total_vat_collected,
        COALESCE((SELECT SUM(rd.rail_cost - COALESCE(rd.rail_vat,0))
                    FROM rail_disbursements rd
                    JOIN payout_items pi2 ON rd.payout_item_id = pi2.id
                    JOIN payout_batches pb2 ON pi2.batch_id = pb2.id
                   WHERE rd.status = 'success'
                     AND pb2.created_at >= $1 AND pb2.created_at <= $2), 0)::bigint AS rail_cost_net,
        COALESCE((SELECT SUM(pi3.item_fee - COALESCE(pi3.item_vat,0))
                    FROM rail_disbursements rd3
                    JOIN payout_items pi3 ON rd3.payout_item_id = pi3.id
                    JOIN payout_batches pb3 ON pi3.batch_id = pb3.id
                   WHERE rd3.status = 'success'
                     AND pb3.created_at >= $1 AND pb3.created_at <= $2), 0)::bigint AS realized_fee_net
      FROM payout_batches pb
      WHERE pb.created_at >= $1 AND pb.created_at <= $2
        ${merchantFilter}
    `, fromDate, toDate);

    // Status breakdown
    const statusBreakdown = await prisma.$queryRawUnsafe(`
      SELECT pi.status AS status, COUNT(*)::int AS count
      FROM payout_items pi
      JOIN payout_batches pb ON pi.batch_id = pb.id
      WHERE pb.created_at >= $1 AND pb.created_at <= $2
      GROUP BY pi.status
      ORDER BY count DESC
    `, fromDate, toDate);

    // Top failure reasons
    const failureReasons = await prisma.$queryRawUnsafe(`
      SELECT
        COALESCE(failure_reason, 'Unknown error') AS reason,
        COUNT(*)::int AS count
      FROM payout_items
      WHERE status = 'failed'
        AND created_at >= $1 AND created_at <= $2
      GROUP BY failure_reason
      ORDER BY count DESC
      LIMIT 10
    `, fromDate, toDate);

    const t = totals[0] || {};
    ok(res, {
      period: { from: fromDate, to: toDate },
      summary: {
        batch_count:        Number(t.batch_count     || 0),
        active_merchants:   Number(t.active_merchants|| 0),
        total_items:        Number(t.total_items      || 0),
        success_items:      Number(t.success_items    || 0),
        failed_items:       Number(t.failed_items     || 0),
        total_amount_naira: koboToNaira(t.total_amount || 0),
        fee_earned_naira:   koboToNaira(t.total_fee_earned || 0),
        vat_collected_naira:koboToNaira(t.total_vat_collected || 0),
        rail_cost_naira:    koboToNaira(t.rail_cost_net || 0),
        // REALIZED profit = fee − rail cost, both over SUCCESSFULLY-disbursed legs only.
        // A pending/un-routed payout contributes 0 (its rail cost isn't known until sent).
        margin_naira:       koboToNaira(Number(t.realized_fee_net || 0) - Number(t.rail_cost_net || 0)),
      },
      by_merchant: byMerchant.map(r => ({
        ...r,
        total_amount_naira:  koboToNaira(r.total_amount || 0),
        fee_earned_naira:    koboToNaira(r.total_fee_earned || 0),
        vat_collected_naira: koboToNaira(r.total_vat_collected || 0),
        rail_cost_naira:     koboToNaira(r.rail_cost_net || 0),
        margin_naira:        koboToNaira(Number(r.realized_fee_net || 0) - Number(r.rail_cost_net || 0)),
        total_deducted_naira:koboToNaira(r.total_deducted || 0),
        success_rate:        r.total_items > 0 ? Math.round(r.success_items / r.total_items * 100) + '%' : '—',
      })),
      status_breakdown: statusBreakdown,
      top_failure_reasons: failureReasons,
      batches: (await prisma.$queryRawUnsafe(`
        SELECT pb.batch_ref, pb.status, pb.total_items, pb.processed_items, pb.failed_items,
               pb.total_amount::text AS total_amount, pb.created_at, m.business_name
        FROM payout_batches pb JOIN merchants m ON m.id = pb.merchant_id
        WHERE pb.created_at >= $1 AND pb.created_at <= $2 ${merchantFilter}
        ORDER BY pb.created_at DESC LIMIT 200`, fromDate, toDate)).map(b => ({
          batch_ref: b.batch_ref, status: b.status, business_name: b.business_name,
          total_items: Number(b.total_items || 0), processed_items: Number(b.processed_items || 0),
          failed_items: Number(b.failed_items || 0), created_at: b.created_at,
          total_amount_naira: koboToNaira(b.total_amount || 0),
        })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/wallet/ledger — wallet transaction history ─────────────
router.get('/wallet/ledger', requireAuth, async (req, res, next) => {
  try {
    const isMerchant   = req.user.role === 'MERCHANT';
    const merchantId   = isMerchant ? req.user.merchant?.id : req.query.merchant_id;
    if (!merchantId)   return fail(res, 'merchant_id required');

    const { page = 1, perPage = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(perPage);

    const [ledger, countResult] = await Promise.all([
      prisma.$queryRaw`
        SELECT wl.*, m.business_name
        FROM wallet_ledger wl
        JOIN merchants m ON wl.merchant_id = m.id
        WHERE wl.merchant_id = ${merchantId}::uuid
        ORDER BY wl.created_at DESC
        LIMIT ${parseInt(perPage)} OFFSET ${offset}
      `,
      prisma.$queryRaw`SELECT COUNT(*)::int AS total FROM wallet_ledger WHERE merchant_id = ${merchantId}::uuid`,
    ]);

    const total = Number(countResult[0]?.total || 0);
    ok(res, {
      data: ledger.map(l => ({
        ...l,
        amount_naira:         koboToNaira(l.amount),
        balance_before_naira: koboToNaira(l.balance_before),
        balance_after_naira:  koboToNaira(l.balance_after),
      })),
      meta: { page: parseInt(page), perPage: parseInt(perPage), total, pages: Math.ceil(total/parseInt(perPage)) },
    });
  } catch (e) { next(e); }
});

// ── Beneficiary address book — background NE runner ─────────────────────────
// Run NE for a list of beneficiary IDs and write ne_status + accountName back.
// Called async via setImmediate — never awaited in a request path.
async function runBeneficiaryNE(merchantId, beneficiaryIds) {
  const plx = (() => {
    try { return require('../services/parallexTransferService'); } catch (_) { return null; }
  })();
  if (!plx || !plx.isConfigured()) return;
  const benefs = await prisma.merchantBeneficiary.findMany({
    where: { id: { in: beneficiaryIds }, merchantId, isActive: true },
    select: { id: true, bankCode: true, accountNumber: true },
  });
  await runPool(benefs.map(b => async () => {
    const ne = await plx.nameEnquiry(b.bankCode, b.accountNumber).catch(() => ({ ok: false, reason: 'NE threw' }));
    await prisma.merchantBeneficiary.update({
      where: { id: b.id },
      data: {
        neStatus:       ne.ok && ne.sessionId ? 'verified' : 'failed',
        accountName:    ne.ok && ne.accountName ? ne.accountName : undefined,
        neCheckedAt:    new Date(),
        neFailureReason: ne.ok ? null : (ne.reason || 'Unknown'),
      },
    });
  }), 10);
}

// ── GET /api/v1/payouts/beneficiaries — list merchant's address book ──────────
router.get('/beneficiaries', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { page = 1, perPage = 100, ne_status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(perPage);
    const where = { merchantId, isActive: true, ...(ne_status ? { neStatus: ne_status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.merchantBeneficiary.findMany({
        where, orderBy: [{ neStatus: 'asc' }, { createdAt: 'desc' }],
        take: parseInt(perPage), skip: offset,
        select: { id: true, accountNumber: true, bankCode: true, bankName: true, accountName: true, alias: true, neStatus: true, neCheckedAt: true, neFailureReason: true, createdAt: true },
      }),
      prisma.merchantBeneficiary.count({ where }),
    ]);
    ok(res, { data: rows, meta: { page: parseInt(page), perPage: parseInt(perPage), total, pages: Math.ceil(total / parseInt(perPage)) } });
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/beneficiaries/sample — download CSV template ──────────
router.get('/beneficiaries/sample', requireAuth, (req, res) => {
  const csv = 'account_number,bank_code,bank_name,alias\r\n0123456789,058,GTBank,John Doe\r\n9876543210,044,Access Bank,Mary Smith\r\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="paylode-beneficiaries-sample.csv"');
  res.send(csv);
});

// ── POST /api/v1/payouts/beneficiaries — add one, trigger NE async ────────────
router.post('/beneficiaries',
  requireAuth,
  body('account_number').isString().isLength({ min: 10, max: 10 }).withMessage('account_number must be 10 digits'),
  body('bank_code').isString().notEmpty().withMessage('bank_code is required'),
  async (req, res, next) => {
    try {
      const errs = validationResult(req);
      if (!errs.isEmpty()) return fail(res, errs.array()[0].msg);
      const merchantId = req.user.merchant?.id;
      if (!merchantId) return fail(res, 'No merchant account');
      const { account_number, bank_code, bank_name, alias } = req.body;
      const benef = await prisma.merchantBeneficiary.upsert({
        where: { merchantId_bankCode_accountNumber: { merchantId, bankCode: bank_code, accountNumber: account_number } },
        create: { merchantId, accountNumber: account_number, bankCode: bank_code, bankName: bank_name || null, alias: alias || null, neStatus: 'pending' },
        update: { isActive: true, bankName: bank_name || undefined, alias: alias || undefined, neStatus: 'pending', neCheckedAt: null, neFailureReason: null },
      });
      setImmediate(() => runBeneficiaryNE(merchantId, [benef.id]).catch(e => logger.error({ err: e }, 'beneficiary NE failed')));
      created(res, { id: benef.id, account_number: benef.accountNumber, bank_code: benef.bankCode, bank_name: benef.bankName, alias: benef.alias, ne_status: 'pending' }, 'Beneficiary added — name verification running in background');
    } catch (e) {
      if (e.code === 'P2002') return fail(res, 'This account is already in your address book');
      next(e);
    }
  }
);

// ── DELETE /api/v1/payouts/beneficiaries/:id — soft-delete ───────────────────
router.delete('/beneficiaries/:id', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const benef = await prisma.merchantBeneficiary.findFirst({ where: { id: req.params.id, merchantId, isActive: true } });
    if (!benef) return notFound(res, 'Beneficiary');
    await prisma.merchantBeneficiary.update({ where: { id: benef.id }, data: { isActive: false } });
    ok(res, { id: benef.id }, 'Removed from address book');
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/beneficiaries/upload — bulk CSV upload, async NE ─────
router.post('/beneficiaries/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    if (!req.file) return fail(res, 'No file uploaded');
    const ext = req.file.originalname.toLowerCase().split('.').pop();
    if (ext !== 'csv') return fail(res, 'Upload a CSV file. Columns: account_number, bank_code, bank_name (optional), alias (optional)');
    const text = req.file.buffer.toString('utf8');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return fail(res, 'File is empty — add at least one row after the header');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
    const validRows = [];
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
      const row = {};
      headers.forEach((h, j) => { row[h] = vals[j] || ''; });
      const acct = (row.account_number || row.accountnumber || row.account || '').replace(/\D/g, '');
      const bank = (row.bank_code || row.bankcode || row.bank || '').trim();
      if (!acct || acct.length !== 10) { errors.push(`Row ${i + 1}: account_number must be 10 digits`); continue; }
      if (!bank) { errors.push(`Row ${i + 1}: bank_code required`); continue; }
      validRows.push({ acct, bank, bankName: row.bank_name || row.bankname || '', alias: row.alias || row.name || '' });
    }
    if (validRows.length === 0) return fail(res, `No valid rows found. Errors: ${errors.slice(0, 3).join('; ')}`);
    if (validRows.length > 2000) return fail(res, 'Maximum 2,000 accounts per upload');
    const newIds = [];
    for (const row of validRows) {
      const b = await prisma.merchantBeneficiary.upsert({
        where: { merchantId_bankCode_accountNumber: { merchantId, bankCode: row.bank, accountNumber: row.acct } },
        create: { merchantId, accountNumber: row.acct, bankCode: row.bank, bankName: row.bankName || null, alias: row.alias || null, neStatus: 'pending' },
        update: { isActive: true, bankName: row.bankName || undefined, alias: row.alias || undefined, neStatus: 'pending', neCheckedAt: null, neFailureReason: null },
      });
      newIds.push(b.id);
    }
    setImmediate(() => runBeneficiaryNE(merchantId, newIds).catch(e => logger.error({ err: e }, 'bulk beneficiary NE failed')));
    ok(res, {
      uploaded: validRows.length, skipped_errors: errors.length, error_samples: errors.slice(0, 5),
      ne_status: 'Name verification running in background — check your address book in a few minutes',
    }, `${validRows.length} accounts added — verifying with bank now`);
  } catch (e) { next(e); }
});

module.exports = router;
// Exposed for the scheduled/auto-dispatch worker (jobs.js) — dispatch is the same
// money code the SA /route endpoint uses.
module.exports.dispatchBatch = dispatchBatch;
module.exports.autoDispatchDuePayouts = autoDispatchDuePayouts;
