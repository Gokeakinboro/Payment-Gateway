'use strict';
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { requireAuth, requireApiKey, requireSuperAdmin, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, created, koboToNaira, generateRef } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');
const { notifyRailIncident } = require('../services/railHealth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Dual-auth middleware: accepts JWT Bearer token OR sk_live_/sk_test_ API key ──
function requireAuthOrApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
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

// ── POST /api/v1/payouts/wallet/fund — SA credits/debits a (merchant, rail) ──
// Every credit MUST be matched to a payout rail (rail_id). Balance = spend cap.
// direction: 'credit' (default) | 'debit'. Debit cannot drive a rail negative.
router.post('/wallet/fund', requireAuth, requireSuperAdmin,
  validate([
    body('merchant_id').notEmpty().withMessage('merchant_id required'),
    body('rail_id').notEmpty().withMessage('rail_id required — every credit must be matched to a payout rail'),
    body('amount').isInt({ min: 1 }).withMessage('amount in kobo required'),
    body('reference').notEmpty().withMessage('payment reference required'),
    body('description').optional().isString(),
    body('direction').optional().isIn(['credit', 'debit']),
  ]),
  async (req, res, next) => {
    try {
      const { merchant_id, rail_id, amount, reference, description } = req.body;
      const direction = req.body.direction === 'debit' ? 'debit' : 'credit';
      const amt = BigInt(amount);

      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id } });
      if (!merchant) return notFound(res, 'Merchant');
      const rail = await prisma.paymentRail.findUnique({ where: { id: rail_id } });
      if (!rail) return notFound(res, 'Rail');
      if (!rail.payoutEnabled) return fail(res, `${rail.name} is not enabled for payouts`);

      const out = await prisma.$transaction(async (tx) => {
        let w = await tx.merchantWallet.findUnique({
          where: { merchantId_railId: { merchantId: merchant_id, railId: rail_id } },
        });
        const before = w ? w.balance : 0n;
        const after  = direction === 'debit' ? before - amt : before + amt;
        if (after < 0n) throw Object.assign(new Error('Debit exceeds the balance on this rail'), { _client: true });
        if (!w) {
          w = await tx.merchantWallet.create({ data: {
            merchantId: merchant_id, railId: rail_id, balance: after,
            lastFundedAt: direction === 'credit' ? new Date() : null, fundedBy: req.user.id,
          }});
        } else {
          w = await tx.merchantWallet.update({ where: { id: w.id }, data: {
            balance: after, ...(direction === 'credit' ? { lastFundedAt: new Date(), fundedBy: req.user.id } : {}),
          }});
        }
        await tx.walletLedger.create({ data: {
          merchantId: merchant_id, railId: rail_id, entryType: direction === 'debit' ? 'DEBIT' : 'CREDIT',
          amount: amt, balanceBefore: before, balanceAfter: after,
          reference, description: description || (direction === 'debit' ? 'SA debit' : 'Wallet funding'), createdBy: req.user.id,
        }});
        return { before, after };
      });

      await logAudit(req.user.id, direction === 'debit' ? 'WALLET_DEBITED' : 'WALLET_FUNDED', 'merchant_wallets', merchant_id,
        { balance: Number(out.before) }, { balance: Number(out.after), rail: rail.name },
        `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(amt).toLocaleString()} on ${rail.name} — Ref: ${reference}`);

      ok(res, {
        merchant_id, business_name: merchant.businessName, rail: rail.name, direction,
        amount: koboToNaira(amt), new_rail_balance: koboToNaira(out.after), reference,
      }, `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(amt).toLocaleString()} ${direction === 'debit' ? 'from' : 'to'} ${merchant.businessName} (${rail.name})`);
    } catch (e) {
      if (e && e._client) return fail(res, e.message);
      next(e);
    }
  }
);

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

// ── GET /api/v1/payouts/banks — list all Nigerian banks ──────────────────────
router.get('/banks', requireAuth, async (req, res, next) => {
  try {
    const banks = await prisma.$queryRaw`
      SELECT bank_code, bank_name, bank_type
      FROM nigerian_banks
      WHERE is_active = true
      ORDER BY bank_name ASC
    `;
    ok(res, banks);
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
    body('items.*.bank_code').notEmpty().withMessage('bank_code required for each item'),
    body('items.*.amount').isInt({ min: 1 }).withMessage('amount in kobo required for each item'),
  ]),
  async (req, res, next) => {
    try {
      const merchantId = req.user.merchant?.id;
      if (!merchantId) return fail(res, 'No merchant account');

      const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
      if (!merchant?.isActive) return fail(res, 'Merchant account is not active');

      const { description, scheduled_at, items } = req.body;

      // ── Lookup payout fee rate (platform default or per-merchant override) ─────
      const VAT_RATE = 0.075; // 7.5% Nigerian VAT on service fees
      const [merchantPayoutRate, platformPayoutRate] = await Promise.all([
        prisma.merchantRateConfig.findFirst({
          where: { merchantId, channel: { in: ['PAYOUT', 'ALL'] } },
          orderBy: { channel: 'asc' },
        }),
        prisma.platformRateConfig.findFirst({
          where: { channel: { in: ['PAYOUT', 'ALL'] } },
          orderBy: { channel: 'asc' },
        }),
      ]);
      const rateConfig = merchantPayoutRate || platformPayoutRate;
      const feeRate    = rateConfig ? Number(rateConfig.rate)      : 0;
      const flatFee    = rateConfig ? BigInt(rateConfig.flatFee)   : 0n;
      const feeCap     = rateConfig ? BigInt(rateConfig.cap)       : 0n;
      const feeMin     = rateConfig ? BigInt(rateConfig.minCharge) : 0n;

      // ── Per-item fee + VAT calculation ─────────────────────────────────────────
      const itemsWithFees = items.map(item => {
        const amt = BigInt(item.amount);
        let fee   = amt * BigInt(Math.round(feeRate * 1_000_000)) / 1_000_000n + flatFee;
        if (feeMin > 0n && fee < feeMin) fee = feeMin;
        if (feeCap > 0n && fee > feeCap) fee = feeCap;
        const vat   = fee * BigInt(Math.round(VAT_RATE * 1_000_000)) / 1_000_000n;
        const total = amt + fee + vat;  // what gets deducted from wallet for this item
        return { ...item, fee, vat, total };
      });

      const totalAmount   = itemsWithFees.reduce((s, i) => s + BigInt(i.amount), 0n);
      const totalFee      = itemsWithFees.reduce((s, i) => s + i.fee,  0n);
      const totalVat      = itemsWithFees.reduce((s, i) => s + i.vat,  0n);
      const totalDeduction = totalAmount + totalFee + totalVat;  // full wallet deduction

      // ── Per-rail hybrid routing (#payout twist, Paylode-internal) ───────────────
      // Pick ONE payout-enabled LIVE rail whose (merchant,rail) balance covers the
      // whole deduction; spread by least-recently-used. If no single rail covers it
      // but the merchant's TOTAL across rails does, queue for SA manual routing.
      // Reject only if the total across all rails is short. Rails are NEVER exposed.
      const railWallets = await prisma.merchantWallet.findMany({
        where: { merchantId, rail: { payoutEnabled: true, status: 'LIVE' } },
        include: { rail: { select: { id: true, name: true } } },
      });
      const totalAcrossRails = railWallets.reduce((s, w) => s + w.balance, 0n);
      const chosen = railWallets
        .filter(w => w.balance >= totalDeduction)
        .sort((a, b) => (a.lastUsedAt ? a.lastUsedAt.getTime() : 0) - (b.lastUsedAt ? b.lastUsedAt.getTime() : 0))[0] || null;

      if (!chosen && totalAcrossRails < totalDeduction) {
        return fail(res,
          `Insufficient wallet balance. Available: ₦${koboToNaira(totalAcrossRails).toLocaleString('en-NG')}, ` +
          `Required: ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')} ` +
          `(₦${koboToNaira(totalAmount).toLocaleString('en-NG')} payouts + ` +
          `₦${koboToNaira(totalFee).toLocaleString('en-NG')} fee + ` +
          `₦${koboToNaira(totalVat).toLocaleString('en-NG')} VAT).`,
          'INSUFFICIENT_BALANCE'
        );
      }

      const needsRouting  = !chosen;                       // total covers it, no single rail does → SA queue
      const chosenRailId  = chosen ? chosen.railId : null;
      const batchRef    = generateRef('PAY');
      const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();
      const isInstant   = !scheduled_at || new Date(scheduled_at) <= new Date();
      const batchStatus = needsRouting ? 'needs_routing' : (isInstant ? 'processing' : 'pending');
      const itemStatus  = needsRouting ? 'queued' : (isInstant ? 'processing' : 'queued');

      // All-or-nothing: atomic GUARDED rail debit (WHERE balance >= amount — blocks
      // concurrent over-spend) + batch + items + ledger in ONE transaction.
      let batchId;
      try {
        await prisma.$transaction(async (tx) => {
          let bBefore = 0n, bAfter = 0n;
          if (chosen) {
            const dec = await tx.$queryRaw`
              UPDATE merchant_wallets
              SET balance = balance - ${totalDeduction}, last_used_at = NOW(), updated_at = NOW()
              WHERE id = ${chosen.id}::uuid AND balance >= ${totalDeduction}
              RETURNING balance`;
            if (!dec.length) throw Object.assign(new Error('Rail balance changed during processing — please retry'), { _client: true });
            bAfter  = dec[0].balance;
            bBefore = bAfter + totalDeduction;
          }
          const batch = await tx.$queryRaw`
            INSERT INTO payout_batches
              (merchant_id, batch_ref, description, total_amount, total_fee, total_vat,
               fee_rate, total_items, status, rail_id, scheduled_at, created_by, created_at, updated_at)
            VALUES
              (${merchantId}::uuid, ${batchRef}, ${description||null},
               ${totalAmount}, ${totalFee}, ${totalVat}, ${feeRate}::decimal,
               ${items.length}, ${batchStatus}, ${chosenRailId}::uuid,
               ${scheduledAt}, ${req.user.id}::uuid, NOW(), NOW())
            RETURNING id`;
          batchId = batch[0].id;
          for (const item of itemsWithFees) {
            const bank = await tx.$queryRaw`SELECT bank_name FROM nigerian_banks WHERE bank_code = ${item.bank_code}`;
            await tx.$executeRaw`
              INSERT INTO payout_items
                (batch_id, merchant_id, account_number, account_name, bank_code, bank_name,
                 amount, item_fee, item_vat, narration, status, scheduled_at, created_at)
              VALUES
                (${batchId}::uuid, ${merchantId}::uuid, ${item.account_number}, ${item.account_name||null},
                 ${item.bank_code}, ${bank[0]?.bank_name||item.bank_code},
                 ${BigInt(item.amount)}, ${item.fee}, ${item.vat},
                 ${item.narration||null}, ${itemStatus}, ${scheduledAt}, NOW())`;
          }
          if (chosen) {
            await tx.$executeRaw`
              INSERT INTO wallet_ledger
                (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
              VALUES
                (${merchantId}::uuid, ${chosenRailId}::uuid, 'DEBIT', ${totalAmount}, ${bBefore}, ${bBefore - totalAmount}, ${batchRef},
                 ${'Payout batch to ' + items.length + ' beneficiaries: ' + (description||batchRef)}, ${req.user.id}::uuid, NOW()),
                (${merchantId}::uuid, ${chosenRailId}::uuid, 'FEE', ${totalFee}, ${bBefore - totalAmount}, ${bBefore - totalAmount - totalFee}, ${batchRef},
                 ${'Paylode payout service fee (' + (feeRate*100).toFixed(2) + '%)'}, ${req.user.id}::uuid, NOW()),
                (${merchantId}::uuid, ${chosenRailId}::uuid, 'VAT', ${totalVat}, ${bBefore - totalAmount - totalFee}, ${bAfter}, ${batchRef},
                 ${'VAT on payout fee (7.5%)'}, ${req.user.id}::uuid, NOW())`;
          }
        }, { timeout: 30000 });
      } catch (e) {
        if (e && e._client) return fail(res, e.message, 'RETRY');
        throw e;
      }

      // Response is MERCHANT-facing — never reveal rails or the SA routing queue.
      created(res, {
        batch_id:             batchId,
        batch_ref:            batchRef,
        total_payout:         koboToNaira(totalAmount),
        total_fee:            koboToNaira(totalFee),
        total_vat:            koboToNaira(totalVat),
        total_deducted:       chosen ? koboToNaira(totalDeduction) : 0,
        total_items:          items.length,
        status:               needsRouting ? 'processing' : (isInstant ? 'processing' : 'scheduled'),
        scheduled_at:         scheduledAt,
        wallet_balance_after: koboToNaira(chosen ? (totalAcrossRails - totalDeduction) : totalAcrossRails),
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
      const narration = r.narration || r.description || r.reference || '';
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

// ── GET /api/v1/payouts/admin/wallets — SA: per-merchant, per-rail balances ───
router.get('/admin/wallets', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const wallets = await prisma.merchantWallet.findMany({
      include: {
        merchant: { select: { businessName: true, merchantCode: true } },
        rail:     { select: { id: true, name: true } },
      },
      orderBy: { balance: 'desc' },
    });
    const byMerchant = {};
    for (const w of wallets) {
      const m = byMerchant[w.merchantId] = byMerchant[w.merchantId] || {
        merchant_id: w.merchantId, business_name: w.merchant.businessName,
        merchant_code: w.merchant.merchantCode, total: 0n, rails: [],
      };
      m.total += w.balance;
      m.rails.push({
        rail_id: w.railId, rail_name: w.rail ? w.rail.name : 'Unallocated',
        balance: Number(w.balance), balance_naira: koboToNaira(w.balance),
        last_used_at: w.lastUsedAt, last_funded_at: w.lastFundedAt,
      });
    }
    const out = Object.values(byMerchant).map(m => ({
      ...m, total: Number(m.total), total_naira: koboToNaira(m.total),
    })).sort((a, b) => b.total - a.total);
    ok(res, out);
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/payout-rails — SA: rails + payout flag ──────────
router.get('/admin/payout-rails', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({
      select: { id: true, name: true, status: true, payoutEnabled: true },
      orderBy: { name: 'asc' },
    });
    ok(res, rails);
  } catch (e) { next(e); }
});

// ── PUT /api/v1/payouts/admin/payout-rails/:id — SA toggles payout-enable/status ─
router.put('/admin/payout-rails/:id', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { payout_enabled, status } = req.body;
    const data = {};
    if (payout_enabled !== undefined) data.payoutEnabled = !!payout_enabled;
    if (status !== undefined) data.status = status;
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
    // attach each merchant's per-rail balances so SA can decide the allocation
    const out = [];
    for (const b of rows) {
      const rw = await prisma.merchantWallet.findMany({
        where: { merchantId: b.merchant_id, rail: { payoutEnabled: true, status: 'LIVE' } },
        include: { rail: { select: { id: true, name: true } } },
      });
      out.push({
        batch_id: b.id, batch_ref: b.batch_ref, business_name: b.business_name, merchant_code: b.merchant_code,
        total_deduction: Number(b.total_amount) + Number(b.total_fee) + Number(b.total_vat),
        total_deduction_naira: koboToNaira(BigInt(b.total_amount) + BigInt(b.total_fee) + BigInt(b.total_vat)),
        total_items: b.total_items, created_at: b.created_at,
        rail_balances: rw.map(w => ({ rail_id: w.railId, rail_name: w.rail ? w.rail.name : 'Unallocated', balance_naira: koboToNaira(w.balance), balance: Number(w.balance) })),
      });
    }
    ok(res, out);
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/admin/batches/:id/route — SA routes a queued batch ───
// body.allocations: [{ rail_id, amount(kobo) }] summing to the batch's total
// deduction. Each rail must hold enough balance. Debits each rail + marks the
// batch processing. (Manual SA judgment for multi-rail splits.)
router.post('/admin/batches/:id/route', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const batchId = req.params.id;
    const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    if (!allocations.length) return fail(res, 'allocations [{rail_id, amount}] required');

    const batchRows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid`;
    const batch = batchRows[0];
    if (!batch) return notFound(res, 'Batch');
    if (batch.status !== 'needs_routing') return fail(res, `Batch is not awaiting routing (status: ${batch.status})`);

    const totalDeduction = BigInt(batch.total_amount) + BigInt(batch.total_fee) + BigInt(batch.total_vat);
    const allocTotal = allocations.reduce((s, a) => s + BigInt(a.amount), 0n);
    if (allocTotal !== totalDeduction)
      return fail(res, `Allocations (₦${koboToNaira(allocTotal).toLocaleString('en-NG')}) must sum to the batch total ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')}`);

    await prisma.$transaction(async (tx) => {
      for (const a of allocations) {
        const w = await tx.merchantWallet.findUnique({
          where: { merchantId_railId: { merchantId: batch.merchant_id, railId: a.rail_id } },
        });
        const amt = BigInt(a.amount);
        if (!w || w.balance < amt) throw Object.assign(new Error('A selected rail no longer has enough balance'), { _client: true });
        const before = w.balance, after = before - amt;
        await tx.merchantWallet.update({ where: { id: w.id }, data: { balance: after, lastUsedAt: new Date() } });
        await tx.walletLedger.create({ data: {
          merchantId: batch.merchant_id, railId: a.rail_id, entryType: 'DEBIT', amount: amt,
          balanceBefore: before, balanceAfter: after, reference: batch.batch_ref,
          description: 'Payout routed by SA (' + batch.batch_ref + ')', createdBy: req.user.id,
        }});
      }
      await tx.$executeRaw`UPDATE payout_batches SET status = 'processing', rail_id = ${allocations[0].rail_id}::uuid, updated_at = NOW() WHERE id = ${batchId}::uuid`;
      await tx.$executeRaw`UPDATE payout_items SET status = 'processing' WHERE batch_id = ${batchId}::uuid`;
    });

    await logAudit(req.user.id, 'PAYOUT_BATCH_ROUTED', 'payout_batches', batchId, {}, { allocations }, null, req.ip);
    ok(res, { batch_id: batchId, status: 'processing' }, 'Batch routed and processing');
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
        SUM(pb.total_amount + pb.total_fee + pb.total_vat)::bigint AS total_deducted
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
        SUM(pb.total_vat)::bigint                             AS total_vat_collected
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
      },
      by_merchant: byMerchant.map(r => ({
        ...r,
        total_amount_naira:  koboToNaira(r.total_amount || 0),
        fee_earned_naira:    koboToNaira(r.total_fee_earned || 0),
        vat_collected_naira: koboToNaira(r.total_vat_collected || 0),
        total_deducted_naira:koboToNaira(r.total_deducted || 0),
        success_rate:        r.total_items > 0 ? Math.round(r.success_items / r.total_items * 100) + '%' : '—',
      })),
      status_breakdown: statusBreakdown,
      top_failure_reasons: failureReasons,
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
        JOIN merchant_wallets mw ON wl.merchant_id = mw.merchant_id
        JOIN merchants m ON mw.merchant_id = m.id
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
