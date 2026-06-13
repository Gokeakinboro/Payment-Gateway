'use strict';
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { requireAuth, requireApiKey, requireSuperAdmin, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, created, koboToNaira, generateRef } = require('../utils/helpers');
const { routeTransaction } = require('../services/feeEngine');
const { logAudit } = require('../services/auditService');

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

// ── GET /api/v1/payouts/wallet — get merchant wallet balance ─────────────────
router.get('/wallet', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');

    let wallet = await prisma.$queryRaw`
      SELECT mw.*, m.business_name
      FROM merchant_wallets mw
      JOIN merchants m ON mw.merchant_id = m.id
      WHERE mw.merchant_id = ${merchantId}::uuid
    `;

    if (wallet.length === 0) {
      // Create wallet if not exists
      await prisma.$executeRaw`
        INSERT INTO merchant_wallets (merchant_id, balance)
        VALUES (${merchantId}::uuid, 0)
        ON CONFLICT (merchant_id) DO NOTHING
      `;
      wallet = [{ balance: 0n, last_funded_at: null }];
    }

    const w = wallet[0];
    ok(res, {
      balance:        Number(w.balance),
      balance_naira:  koboToNaira(w.balance),
      last_funded_at: w.last_funded_at,
      merchant_id:    merchantId,
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/payouts/wallet/fund — super admin funds merchant wallet ──────
router.post('/wallet/fund', requireAuth, requireSuperAdmin,
  validate([
    body('merchant_id').notEmpty().withMessage('merchant_id required'),
    body('amount').isInt({ min: 1 }).withMessage('amount in kobo required'),
    body('reference').notEmpty().withMessage('payment reference required'),
    body('description').optional().isString(),
  ]),
  async (req, res, next) => {
    try {
      const { merchant_id, amount, reference, description } = req.body;
      const amt = BigInt(amount);

      // Verify merchant exists
      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id } });
      if (!merchant) return notFound(res, 'Merchant');

      // Get or create wallet
      await prisma.$executeRaw`
        INSERT INTO merchant_wallets (merchant_id, balance)
        VALUES (${merchant_id}::uuid, 0)
        ON CONFLICT (merchant_id) DO NOTHING
      `;

      // Credit wallet atomically
      const result = await prisma.$queryRaw`
        UPDATE merchant_wallets
        SET balance = balance + ${amt},
            last_funded_at = NOW(),
            funded_by = ${req.user.id}::uuid,
            updated_at = NOW()
        WHERE merchant_id = ${merchant_id}::uuid
        RETURNING balance, (balance - ${amt}) as balance_before
      `;

      const newBalance  = result[0].balance;
      const balBefore   = result[0].balance_before;

      // Write ledger entry
      await prisma.$executeRaw`
        INSERT INTO wallet_ledger
          (merchant_id, entry_type, amount, balance_before, balance_after, reference, description, created_by)
        VALUES
          (${merchant_id}::uuid, 'CREDIT', ${amt}, ${balBefore}, ${newBalance},
           ${reference}, ${description||'Wallet funding'}, ${req.user.id}::uuid)
      `;

      await logAudit(req.user.id, 'WALLET_FUNDED', 'merchant_wallets', merchant_id,
        { balance: Number(balBefore) }, { balance: Number(newBalance) },
        `Funded ₦${koboToNaira(amt).toLocaleString()} — Ref: ${reference}`);

      ok(res, {
        merchant_id,
        business_name:  merchant.businessName,
        amount_credited:koboToNaira(amt),
        new_balance:    koboToNaira(newBalance),
        reference,
      }, `Wallet funded — ₦${koboToNaira(amt).toLocaleString()} credited to ${merchant.businessName}`);
    } catch (e) { next(e); }
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

      // ── Ensure wallet exists and has sufficient balance ─────────────────────────
      await prisma.$executeRaw`
        INSERT INTO merchant_wallets (merchant_id, balance, created_at, updated_at)
        VALUES (${merchantId}::uuid, 0, NOW(), NOW())
        ON CONFLICT (merchant_id) DO NOTHING
      `;
      const walletRow = await prisma.$queryRaw`
        SELECT balance FROM merchant_wallets WHERE merchant_id = ${merchantId}::uuid
      `;
      const balance = walletRow[0]?.balance ?? 0n;

      if (balance < totalDeduction) {
        return fail(res,
          `Insufficient wallet balance. Available: ₦${koboToNaira(balance).toLocaleString('en-NG')}, ` +
          `Required: ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')} ` +
          `(₦${koboToNaira(totalAmount).toLocaleString('en-NG')} payouts + ` +
          `₦${koboToNaira(totalFee).toLocaleString('en-NG')} fee + ` +
          `₦${koboToNaira(totalVat).toLocaleString('en-NG')} VAT).`,
          'INSUFFICIENT_BALANCE'
        );
      }

      // ── Rail routing ────────────────────────────────────────────────────────────
      let rail = null;
      try {
        rail = await routeTransaction(prisma, 'PAYOUT', totalAmount,
          merchant.designatedRailId, merchant.allowFallback);
      } catch (_) { /* No live payout rail — batch queued for later processing */ }

      const batchRef    = generateRef('PAY');
      const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();

      // ── Create batch record ─────────────────────────────────────────────────────
      const batch = await prisma.$queryRaw`
        INSERT INTO payout_batches
          (merchant_id, batch_ref, description, total_amount, total_fee, total_vat,
           fee_rate, total_items, status, rail_id, scheduled_at, created_by, created_at, updated_at)
        VALUES
          (${merchantId}::uuid, ${batchRef}, ${description||null},
           ${totalAmount}, ${totalFee}, ${totalVat},
           ${feeRate}::decimal,
           ${items.length}, 'pending',
           ${rail?.railId || null}::uuid,
           ${scheduledAt}, ${req.user.id}::uuid, NOW(), NOW())
        RETURNING *
      `;
      const batchId = batch[0].id;

      // ── Create payout items ─────────────────────────────────────────────────────
      for (const item of itemsWithFees) {
        const bank = await prisma.$queryRaw`
          SELECT bank_name FROM nigerian_banks WHERE bank_code = ${item.bank_code}
        `;
        await prisma.$executeRaw`
          INSERT INTO payout_items
            (batch_id, merchant_id, account_number, account_name, bank_code, bank_name,
             amount, item_fee, item_vat, narration, status, scheduled_at, created_at)
          VALUES
            (${batchId}::uuid, ${merchantId}::uuid,
             ${item.account_number}, ${item.account_name||null},
             ${item.bank_code}, ${bank[0]?.bank_name||item.bank_code},
             ${BigInt(item.amount)}, ${item.fee}, ${item.vat},
             ${item.narration||null}, 'queued', ${scheduledAt}, NOW())
        `;
      }

      // ── Debit full amount (payouts + fee + VAT) from wallet atomically ──────────
      await prisma.$executeRaw`
        UPDATE merchant_wallets
        SET balance = balance - ${totalDeduction}, updated_at = NOW()
        WHERE merchant_id = ${merchantId}::uuid
      `;

      const balanceAfter = balance - totalDeduction;

      // ── Write three ledger entries: payout, fee, VAT ────────────────────────────
      await prisma.$executeRaw`
        INSERT INTO wallet_ledger
          (merchant_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
        VALUES
          (${merchantId}::uuid, 'DEBIT', ${totalAmount}, ${balance},
           ${balance - totalAmount}, ${batchRef},
           ${'Payout batch to ' + items.length + ' beneficiaries: ' + (description||batchRef)},
           ${req.user.id}::uuid, NOW()),
          (${merchantId}::uuid, 'FEE', ${totalFee}, ${balance - totalAmount},
           ${balance - totalAmount - totalFee}, ${batchRef},
           ${'Paylode payout service fee (' + (feeRate*100).toFixed(2) + '%)'},
           ${req.user.id}::uuid, NOW()),
          (${merchantId}::uuid, 'VAT', ${totalVat}, ${balance - totalAmount - totalFee},
           ${balanceAfter}, ${batchRef},
           ${'VAT on payout fee (7.5%)'},
           ${req.user.id}::uuid, NOW())
      `;

      // ── Update status to processing if instant ──────────────────────────────────
      const isInstant = !scheduled_at || new Date(scheduled_at) <= new Date();
      if (isInstant) {
        await prisma.$executeRaw`
          UPDATE payout_batches SET status = 'processing', updated_at = NOW() WHERE id = ${batchId}::uuid
        `;
        await prisma.$executeRaw`
          UPDATE payout_items SET status = 'processing' WHERE batch_id = ${batchId}::uuid
        `;
      }

      created(res, {
        batch_id:             batchId,
        batch_ref:            batchRef,
        total_payout:         koboToNaira(totalAmount),
        total_fee:            koboToNaira(totalFee),
        total_vat:            koboToNaira(totalVat),
        total_deducted:       koboToNaira(totalDeduction),
        total_items:          items.length,
        status:               isInstant ? 'processing' : 'scheduled',
        scheduled_at:         scheduledAt,
        rail:                 rail?.railName || 'Pending rail assignment',
        wallet_balance_after: koboToNaira(balanceAfter),
        fee_rate_pct:         (feeRate * 100).toFixed(2) + '%',
      }, `Payout batch created — ${items.length} beneficiaries, ₦${koboToNaira(totalAmount).toLocaleString('en-NG')} (fee: ₦${koboToNaira(totalFee).toLocaleString('en-NG')})`);
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

    const where = merchantId ? `WHERE pb.merchant_id = '${merchantId}'::uuid` : '';

    const batches = await prisma.$queryRaw`
      SELECT pb.*, m.business_name, pr.name as rail_name
      FROM payout_batches pb
      JOIN merchants m ON pb.merchant_id = m.id
      LEFT JOIN payment_rails pr ON pb.rail_id = pr.id
      ORDER BY pb.created_at DESC
      LIMIT 50
    `;

    ok(res, batches.map(b => ({
      ...b,
      total_amount_naira: koboToNaira(b.total_amount),
    })));
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

// ── GET /api/v1/payouts/admin/wallets — super admin: all wallet balances ──────
router.get('/admin/wallets', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const wallets = await prisma.$queryRaw`
      SELECT mw.*, m.business_name, m.merchant_code
      FROM merchant_wallets mw
      JOIN merchants m ON mw.merchant_id = m.id
      ORDER BY mw.balance DESC
    `;
    ok(res, wallets.map(w => ({ ...w, balance_naira: koboToNaira(w.balance) })));
  } catch (e) { next(e); }
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
