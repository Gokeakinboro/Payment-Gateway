'use strict';
const router  = require('express').Router();
const crypto  = require('crypto');
const multer  = require('multer');
const { body, validationResult } = require('express-validator');
const { prisma }  = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, created, koboToNaira, generateRef } = require('../utils/helpers');
const { routeTransaction } = require('../services/feeEngine');
const { logAudit } = require('../services/auditService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
router.post('/batches', requireAuth,
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

      // Calculate total
      const totalAmount = items.reduce((sum, i) => sum + BigInt(i.amount), 0n);

      // Check wallet balance
      const wallet = await prisma.$queryRaw`
        SELECT balance FROM merchant_wallets WHERE merchant_id = ${merchantId}::uuid
      `;
      const balance = wallet[0]?.balance ?? 0n;

      if (balance < totalAmount) {
        return fail(res,
          `Insufficient wallet balance. Available: ₦${koboToNaira(balance).toLocaleString()}, Required: ₦${koboToNaira(totalAmount).toLocaleString()}`,
          'INSUFFICIENT_BALANCE'
        );
      }

      // Get payout rail (merchant designated or lowest cost)
      let rail = null;
      try {
        rail = await routeTransaction(prisma, 'PAYOUT', totalAmount,
          merchant.designatedRailId, merchant.allowFallback);
      } catch (e) {
        // No live payout rail — create batch in pending state for later processing
      }

      const batchRef = generateRef('PAY');
      const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();

      // Create batch
      const batch = await prisma.$queryRaw`
        INSERT INTO payout_batches
          (merchant_id, batch_ref, description, total_amount, total_items, status,
           rail_id, scheduled_at, created_by)
        VALUES
          (${merchantId}::uuid, ${batchRef}, ${description||null}, ${totalAmount},
           ${items.length}, 'pending',
           ${rail?.railId || null}::uuid,
           ${scheduledAt}, ${req.user.id}::uuid)
        RETURNING *
      `;

      const batchId = batch[0].id;

      // Create payout items
      for (const item of items) {
        // Look up bank name
        const bank = await prisma.$queryRaw`
          SELECT bank_name FROM nigerian_banks WHERE bank_code = ${item.bank_code}
        `;

        await prisma.$executeRaw`
          INSERT INTO payout_items
            (batch_id, merchant_id, account_number, account_name, bank_code, bank_name,
             amount, narration, status, scheduled_at)
          VALUES
            (${batchId}::uuid, ${merchantId}::uuid,
             ${item.account_number}, ${item.account_name||null},
             ${item.bank_code}, ${bank[0]?.bank_name||item.bank_code},
             ${BigInt(item.amount)}, ${item.narration||null},
             'queued', ${scheduledAt})
        `;
      }

      // Debit wallet immediately (reserve funds)
      await prisma.$executeRaw`
        UPDATE merchant_wallets
        SET balance = balance - ${totalAmount}, updated_at = NOW()
        WHERE merchant_id = ${merchantId}::uuid
      `;

      // Write ledger debit
      await prisma.$executeRaw`
        INSERT INTO wallet_ledger
          (merchant_id, entry_type, amount, balance_before, balance_after, reference, description, created_by)
        VALUES
          (${merchantId}::uuid, 'DEBIT', ${totalAmount}, ${balance},
           ${balance - totalAmount}, ${batchRef},
           ${'Payout batch: ' + (description||batchRef)}, ${req.user.id}::uuid)
      `;

      // If instant (now or past), queue for processing
      const isInstant = !scheduled_at || new Date(scheduled_at) <= new Date();
      if (isInstant) {
        // Update to processing status
        await prisma.$executeRaw`
          UPDATE payout_batches SET status = 'processing' WHERE id = ${batchId}::uuid
        `;
        // In production: dispatch to BullMQ job queue
        // For now: mark items as processing
        await prisma.$executeRaw`
          UPDATE payout_items SET status = 'processing' WHERE batch_id = ${batchId}::uuid
        `;
      }

      created(res, {
        batch_id:      batchId,
        batch_ref:     batchRef,
        total_amount:  koboToNaira(totalAmount),
        total_items:   items.length,
        status:        isInstant ? 'processing' : 'scheduled',
        scheduled_at:  scheduledAt,
        rail:          rail?.railName || 'Pending rail assignment',
        wallet_balance_after: koboToNaira(balance - totalAmount),
      }, `Payout batch created — ${items.length} beneficiaries, ₦${koboToNaira(totalAmount).toLocaleString()}`);
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

    ok(res, {
      batch: { ...batch[0], total_amount_naira: koboToNaira(batch[0].total_amount) },
      items: items.map(i => ({ ...i, amount_naira: koboToNaira(i.amount) })),
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

    ok(res, wallets.map(w => ({
      ...w,
      balance_naira: koboToNaira(w.balance),
    })));
  } catch (e) { next(e); }
});

module.exports = router;
