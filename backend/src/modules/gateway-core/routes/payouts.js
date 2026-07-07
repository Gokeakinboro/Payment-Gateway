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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── "On-us" payout destinations ──────────────────────────────────────────────
// A payout to one of these banks settles inside our own rail network (currently
// PalmPay, NIBSS code 100033), so it is cheaper for the rail to move and we price
// it lower for the merchant. On-us payouts resolve the PAYOUT_ONUS fee config;
// everything else uses the standard PAYOUT config. Identifier only — the actual
// FEE amounts live in editable rate config, never hardcoded.
const ON_US_BANK_CODES = new Set(['100033']);  // PalmPay
const isOnUsBank = (code) => ON_US_BANK_CODES.has(String(code || '').trim());

// ── Per-rail payout liquidity helpers ─────────────────────────────────────────
// Payouts are pre-funded PER RAIL: a merchant holds one merchant_wallets row per
// rail and may only pay out through a rail up to (a) what they funded there AND
// (b) that rail's remaining DAILY send-out cap. These run inside a tx so the read
// and the guarded debit see a consistent snapshot.

// Per-rail payout balances for a merchant (payout-enabled rails with a row).
async function railBalancesForMerchant(tx, merchantId) {
  return tx.$queryRaw`
    SELECT mw.rail_id, mw.balance, pr.name AS rail_name, pr.daily_value_cap
    FROM merchant_wallets mw
    JOIN payment_rails pr ON pr.id = mw.rail_id
    WHERE mw.merchant_id = ${merchantId}::uuid AND mw.rail_id IS NOT NULL
      AND pr.payout_enabled = true
    ORDER BY mw.balance DESC`;
}

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

// Greedy per-item assignment of payout items to a merchant's funded rails.
//   rails: [{ rail_id, rail_name, balance(BigInt), remainingCap(BigInt|null) }]
//   items: each needs `total` (beneficiary+fee+VAT — debited from the rail wallet)
//          and `amount` (beneficiary — counts against the rail's daily cap).
// A single beneficiary goes through ONE rail (you can't split one transfer), so an
// item must fit entirely in one rail's balance. Largest beneficiary first; picks the
// rail with the most spare balance that can also fit the beneficiary under its cap.
// Returns { ok, assignments:[{item, rail_id}] } or { ok:false, reason }.
function allocateItemsAcrossRails(rails, items) {
  const work = rails.map(r => ({ ...r, spend: 0n, capUsed: 0n }));
  const assignments = [];
  const ordered = [...items].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  for (const it of ordered) {
    const total = BigInt(it.total), amt = BigInt(it.amount);
    const candidates = work.filter(r =>
      (r.balance - r.spend) >= total &&
      (r.remainingCap == null || (r.remainingCap - r.capUsed) >= amt));
    if (!candidates.length) {
      const balanceOk = work.some(r => (r.balance - r.spend) >= total);
      return { ok: false, reason: balanceOk ? 'daily_cap' : 'insufficient' };
    }
    candidates.sort((a, b) => ((b.balance - b.spend) > (a.balance - a.spend) ? 1 : -1));
    const pick = candidates[0];
    pick.spend += total; pick.capUsed += amt;
    assignments.push({ item: it, rail_id: pick.rail_id });
  }
  return { ok: true, assignments };
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
      // Payouts are prepaid — a merchant still undergoing KYC MAY run live payouts
      // as long as their wallet is funded (the balance check below is the safeguard).
      // Only a SUSPENDED or REJECTED account is hard-blocked from payouts.
      if (['SUSPENDED', 'KYC_REJECTED'].includes(merchant.kycStatus))
        return fail(res, 'Account is suspended or rejected — payouts are disabled', 'ACCOUNT_BLOCKED');

      const { description, scheduled_at, items } = req.body;

      // Narration is mandatory on every payout. When the merchant leaves it blank
      // (dashboard form, XLS/CSV file, or API payload), default it to
      // "Payment from <business name>" so the beneficiary always sees a meaningful
      // reference on their bank statement.
      const defaultNarration = `Payment from ${merchant.businessName}`;

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
      const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();
      const batchStatus = 'needs_routing';   // SA triggers disbursement
      const itemStatus  = 'queued';

      let batchId, walletAfterTotal;
      try {
        await prisma.$transaction(async (tx) => {
          // The merchant's funded rails + each rail's remaining daily send-out cap.
          const railRows = await railBalancesForMerchant(tx, merchantId);
          if (!railRows.length)
            throw Object.assign(new Error('No funded payout rail — fund a rail before sending payouts.'),
              { _client: true, _code: 'NO_FUNDED_RAIL' });
          const railState = [];
          for (const r of railRows) {
            railState.push({
              rail_id: r.rail_id, rail_name: r.rail_name, balance: BigInt(r.balance),
              remainingCap: await remainingDailyCap(tx, r.rail_id, r.daily_value_cap),
            });
          }

          // Assign each beneficiary to a rail (balance + daily-cap aware).
          const alloc = allocateItemsAcrossRails(railState, itemsWithFees);
          if (!alloc.ok) {
            const totalFunded = railState.reduce((s, r) => s + r.balance, 0n);
            const msg = alloc.reason === 'daily_cap'
              ? 'Daily payout limit reached on the funded rail(s) for this amount — try again later, or fund/rebalance another rail.'
              : `Insufficient pre-funded balance. Funded across rails: ₦${koboToNaira(totalFunded).toLocaleString('en-NG')}, ` +
                `required ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')} ` +
                `(₦${koboToNaira(totalAmount).toLocaleString('en-NG')} payouts + ₦${koboToNaira(totalFee).toLocaleString('en-NG')} fee + ₦${koboToNaira(totalVat).toLocaleString('en-NG')} VAT). ` +
                `A single beneficiary must fit within one rail's balance.`;
            throw Object.assign(new Error(msg),
              { _client: true, _code: alloc.reason === 'daily_cap' ? 'DAILY_CAP' : 'INSUFFICIENT_BALANCE' });
          }
          const railOf = new Map(alloc.assignments.map(a => [a.item, a.rail_id]));
          const nameOf = Object.fromEntries(railState.map(r => [r.rail_id, r.rail_name]));

          // Per-rail totals (beneficiary / fee / VAT / full wallet debit).
          const byRail = new Map();
          for (const it of itemsWithFees) {
            const rid = railOf.get(it);
            const g = byRail.get(rid) || { beneficiary: 0n, fee: 0n, vat: 0n, total: 0n };
            g.beneficiary += BigInt(it.amount); g.fee += it.fee; g.vat += it.vat; g.total += it.total;
            byRail.set(rid, g);
          }

          // Create the batch (rail_id NULL — the per-rail split lives on the items).
          const batch = await tx.$queryRaw`
            INSERT INTO payout_batches
              (merchant_id, batch_ref, description, total_amount, total_fee, total_vat,
               fee_rate, total_items, status, rail_id, scheduled_at, created_by, created_at, updated_at)
            VALUES
              (${merchantId}::uuid, ${batchRef}, ${description||null},
               ${totalAmount}, ${totalFee}, ${totalVat}, ${feeRate}::decimal,
               ${items.length}, ${batchStatus}, NULL,
               ${scheduledAt}, ${req.user.id}::uuid, NOW(), NOW())
            RETURNING id`;
          batchId = batch[0].id;

          // GUARDED per-(merchant,rail) wallet debit + per-rail ledger (DEBIT/FEE/VAT).
          for (const [rid, g] of byRail) {
            const dec = await tx.$queryRaw`
              UPDATE merchant_wallets
              SET balance = balance - ${g.total}, last_used_at = NOW(), updated_at = NOW()
              WHERE merchant_id = ${merchantId}::uuid AND rail_id = ${rid}::uuid AND balance >= ${g.total}
              RETURNING balance`;
            if (!dec.length) throw Object.assign(new Error('Balance changed during processing — please retry'), { _client: true });
            const bAfter  = BigInt(dec[0].balance);
            const bBefore = bAfter + g.total;
            await tx.$executeRaw`
              INSERT INTO wallet_ledger
                (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
              VALUES
                (${merchantId}::uuid, ${rid}::uuid, 'DEBIT', ${g.beneficiary}, ${bBefore}, ${bBefore - g.beneficiary}, ${batchRef},
                 ${'Payout via ' + (nameOf[rid]||'rail') + ': ' + (description||batchRef)}, ${req.user.id}::uuid, NOW()),
                (${merchantId}::uuid, ${rid}::uuid, 'FEE', ${g.fee}, ${bBefore - g.beneficiary}, ${bBefore - g.beneficiary - g.fee}, ${batchRef},
                 ${'Paylode payout service fee (' + (feeRate*100).toFixed(2) + '%)'}, ${req.user.id}::uuid, NOW()),
                (${merchantId}::uuid, ${rid}::uuid, 'VAT', ${g.vat}, ${bBefore - g.beneficiary - g.fee}, ${bAfter}, ${batchRef},
                 ${'VAT on payout fee (7.5%)'}, ${req.user.id}::uuid, NOW())`;
          }

          // Insert items, each tagged with its assigned rail.
          for (const item of itemsWithFees) {
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
                 ${itemStatus}, ${railOf.get(item)}::uuid, ${scheduledAt}, NOW())`;
          }

          // New TOTAL across the merchant's rails (for the merchant-facing response).
          const allRows = await tx.merchantWallet.findMany({ where: { merchantId }, select: { balance: true } });
          walletAfterTotal = allRows.reduce((s, r) => s + r.balance, 0n);
        }, { timeout: 30000 });
      } catch (e) {
        if (e && e._client) return fail(res, e.message, e._code || 'RETRY');
        throw e;
      }

      // Response is MERCHANT-facing — never reveal rails or the SA routing queue.
      // Single-balance model: the wallet is always debited and every batch awaits
      // SA routing (merchant sees 'processing'). (Was referencing undefined leftover
      // vars chosen/needsRouting/isInstant/totalAcrossRails → threw AFTER commit = 500.)
      const isScheduled = scheduledAt && scheduledAt.getTime() > Date.now() + 1000;
      created(res, {
        batch_id:             batchId,
        batch_ref:            batchRef,
        total_payout:         koboToNaira(totalAmount),
        total_fee:            koboToNaira(totalFee),
        total_vat:            koboToNaira(totalVat),
        total_deducted:       koboToNaira(totalDeduction),
        total_items:          items.length,
        status:               isScheduled ? 'scheduled' : 'processing',
        scheduled_at:         scheduledAt,
        wallet_balance_after: koboToNaira(walletAfterTotal),
        fee_rate_pct:         (feeRate * 100).toFixed(2) + '%',
      }, `Payout received — ${items.length} beneficiaries, ₦${koboToNaira(totalAmount).toLocaleString('en-NG')} (fee: ₦${koboToNaira(totalFee).toLocaleString('en-NG')})`);
    } catch (e) { next(e); }
  }
);

// ── POST /api/v1/payouts/batches/upload — CSV/Excel upload ───────────────────
router.post('/batches/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return fail(res, 'No file uploaded');

    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');

    // For the preview we resolve the same default narration the batch-create path
    // applies, so the merchant sees exactly what each beneficiary will receive.
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId }, select: { businessName: true },
    });
    const defaultNarration = `Payment from ${merchant?.businessName || 'merchant'}`;

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
             pb.total_items, pb.created_at, m.id AS merchant_id, m.business_name, m.merchant_code
      FROM payout_batches pb
      JOIN merchants m ON pb.merchant_id = m.id
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

// ── POST /api/v1/payouts/admin/batches/:id/route — SA disburses a queued batch ─
// The per-rail split was decided at batch creation: each payout_item carries its
// rail_id and the merchant's per-rail wallet was already debited there. Routing
// just EXECUTES that split — debit the rail float + disburse each leg. To change
// the rail mix, SA rebalances the merchant's funds first (POST /admin/wallet/
// rebalance) and recreates. No allocations body needed. Guarded against float + cap.
router.post('/admin/batches/:id/route', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const batchId = req.params.id;

    const batchRows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid`;
    const batch = batchRows[0];
    if (!batch) return notFound(res, 'Batch');
    if (batch.status !== 'needs_routing') return fail(res, `Batch is not awaiting routing (status: ${batch.status})`);

    // Items already carry their assigned rail (set at creation). Group by rail.
    const items = await prisma.$queryRaw`
      SELECT id, amount, bank_code, rail_id FROM payout_items WHERE batch_id = ${batchId}::uuid ORDER BY amount DESC`;
    if (items.some(it => !it.rail_id))
      return fail(res, 'This batch has unassigned items — it predates per-rail routing. Recreate the payout.');
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
      if (!r || !r.payoutEnabled) return fail(res, 'A selected rail is not payout-enabled.');
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
        const costForItem = (bankCode) => isOnUsBank(bankCode) ? r.payoutFlatCostOnUs : r.payoutFlatCost;
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
    const palmpay = require('../services/palmpayService');
    const railAdapter = (name) => (/palmpay/i.test(name || '') ? palmpay : null);
    const legs = await prisma.$queryRaw`
      SELECT rd.id AS leg_id, rd.rail_id, rd.amount, rd.rail_cost, rd.rail_vat, rd.rail_order_id,
             pi.id AS item_id, pi.account_number, pi.account_name, pi.bank_code, pi.narration,
             pi.item_fee, pi.item_vat
      FROM rail_disbursements rd JOIN payout_items pi ON rd.payout_item_id = pi.id
      WHERE rd.batch_id = ${batchId}::uuid AND rd.status = 'pending'`;
    let nOk = 0, nFail = 0, nPending = 0;
    for (const leg of legs) {
      const rail = railById[leg.rail_id];
      const adapter = railAdapter(rail && rail.name);
      let r;
      try {
        if (!adapter || !adapter.isConfigured()) r = { ok: false, reason: 'Rail adapter not configured' };
        else r = await adapter.sendPayout({
          orderId: leg.rail_order_id, amount: Number(leg.amount), bank_code: leg.bank_code,
          account_number: leg.account_number, account_name: leg.account_name, narration: leg.narration,
        });
      } catch (e) { r = { ok: false, reason: e.message }; }

      // The rail's create response only means ACCEPTED (respCode ok), not SETTLED.
      // The authoritative settle result arrives via the payout webhook (orderStatus).
      // So: orderStatus 2 = settled now; 1/0/absent = accepted & in flight → leave
      // the money debited and mark the leg 'sent' to await the webhook; a hard reject
      // (r.ok false) or a terminal failure code → refund float + wallet immediately.
      const os = r.ok ? String(r.orderStatus == null ? '' : r.orderStatus) : null;
      const railFee = (r.raw && r.raw.data && r.raw.data.fee && r.raw.data.fee.fee) || Number(leg.rail_cost);
      const sess = (r.raw && r.raw.data && r.raw.data.sessionId) || null;

      if (r.ok && os === '2') {                       // terminal SUCCESS now
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='success', rail_order_no=${r.providerRef || null}, rail_session_id=${sess}, rail_fee=${railFee}, sent_at=NOW(), settled_at=NOW(), updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='success', provider_ref=${r.providerRef || null}, processed_at=NOW() WHERE id=${leg.item_id}::uuid`;
        nOk++;
        await recordRailResult(rail, { ok: true });   // accepted+settled → reset the rail's fail streak
      } else if (r.ok && (os === '' || os === '1' || os === '0')) {   // ACCEPTED, in flight
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='sent', rail_order_no=${r.providerRef || null}, rail_session_id=${sess}, rail_fee=${railFee}, sent_at=NOW(), updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='processing', provider_ref=${r.providerRef || null} WHERE id=${leg.item_id}::uuid`;
        nPending++;
        await recordRailResult(rail, { ok: true });   // accepted by the rail → not a failure
      } else {                                        // hard reject / terminal failure → refund
        const reason = r.ok ? `Rail returned orderStatus ${os}` : (r.reason || 'failed');
        const floatBack = BigInt(leg.amount) + BigInt(leg.rail_cost || 0) + BigInt(leg.rail_vat || 0);
        const merchBack = BigInt(leg.amount) + BigInt(leg.item_fee || 0) + BigInt(leg.item_vat || 0);
        await prisma.$executeRaw`UPDATE payment_rails SET float_balance = float_balance + ${floatBack}, updated_at=NOW() WHERE id=${leg.rail_id}::uuid`;
        await prisma.$executeRaw`UPDATE merchant_wallets SET balance = balance + ${merchBack}, updated_at=NOW() WHERE merchant_id=${batch.merchant_id}::uuid AND rail_id=${leg.rail_id}::uuid`;
        await prisma.$executeRaw`UPDATE rail_disbursements SET status='failed', error_msg=${String(reason).slice(0, 280)}, updated_at=NOW() WHERE id=${leg.leg_id}::uuid`;
        await prisma.$executeRaw`UPDATE payout_items SET status='failed', failure_reason=${String(reason).slice(0, 280)} WHERE id=${leg.item_id}::uuid`;
        nFail++;
        // Track the rail's failure streak → SA is emailed (debounced) at the
        // threshold, or immediately if the rail signals a low/insufficient balance.
        await recordRailResult(rail, { ok: false, reason, isLowBalance: /insufficient|balance|fund|limit/i.test(String(reason)) },
          { railId: leg.rail_id, railName: rail && rail.name, merchant: batch.merchant_id });
      }
    }
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

    await logAudit(req.user.id, 'PAYOUT_BATCH_DISBURSED', 'payout_batches', batchId, {},
      { rails_used: used.length, settled: nOk, pending: nPending, failed: nFail, status: finalStatus }, null, req.ip);
    ok(res, { batch_id: batchId, status: finalStatus, settled: nOk, pending: nPending, failed: nFail },
      `Payout ${finalStatus} — ${nOk} settled${nPending ? `, ${nPending} processing` : ''}${nFail ? `, ${nFail} failed (refunded)` : ''}`);
  } catch (e) {
    if (e && e._client) return fail(res, e.message);
    next(e);
  }
});

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

module.exports = router;
