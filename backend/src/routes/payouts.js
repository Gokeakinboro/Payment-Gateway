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
const { BANKS, resolveBank } = require('../data/nibssBanks');
const { syncRailFloat } = require('../services/railFloat');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// ── POST /api/v1/payouts/wallet/fund — SA credits/debits a merchant's BALANCE ─
// Single balance per merchant (rails are internal — funding is NOT per rail).
// direction: 'credit' (default) | 'debit'. Debit cannot drive the balance negative.
router.post('/wallet/fund', requireAuth, requireSuperAdmin,
  validate([
    body('merchant_id').notEmpty().withMessage('merchant_id required'),
    body('amount').isInt({ min: 1 }).withMessage('amount in kobo required'),
    body('reference').notEmpty().withMessage('payment reference required'),
    body('description').optional().isString(),
    body('direction').optional().isIn(['credit', 'debit']),
  ]),
  async (req, res, next) => {
    try {
      const { merchant_id, amount, reference, description } = req.body;
      const direction = req.body.direction === 'debit' ? 'debit' : 'credit';
      const amt = BigInt(amount);

      const merchant = await prisma.merchant.findUnique({ where: { id: merchant_id } });
      if (!merchant) return notFound(res, 'Merchant');

      const out = await prisma.$transaction(async (tx) => {
        let w = await tx.merchantWallet.findFirst({ where: { merchantId: merchant_id } });
        const before = w ? w.balance : 0n;
        const after  = direction === 'debit' ? before - amt : before + amt;
        if (after < 0n) throw Object.assign(new Error('Debit exceeds the merchant balance'), { _client: true });
        if (!w) {
          w = await tx.merchantWallet.create({ data: {
            merchantId: merchant_id, balance: after,
            lastFundedAt: direction === 'credit' ? new Date() : null, fundedBy: req.user.id,
          }});
        } else {
          w = await tx.merchantWallet.update({ where: { id: w.id }, data: {
            balance: after, ...(direction === 'credit' ? { lastFundedAt: new Date(), fundedBy: req.user.id } : {}),
          }});
        }
        await tx.walletLedger.create({ data: {
          merchantId: merchant_id, entryType: direction === 'debit' ? 'DEBIT' : 'CREDIT',
          amount: amt, balanceBefore: before, balanceAfter: after,
          reference, description: description || (direction === 'debit' ? 'SA debit' : 'Wallet funding'), createdBy: req.user.id,
        }});
        return { before, after };
      });

      await logAudit(req.user.id, direction === 'debit' ? 'WALLET_DEBITED' : 'WALLET_FUNDED', 'merchant_wallets', merchant_id,
        { balance: Number(out.before) }, { balance: Number(out.after) },
        `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(amt).toLocaleString()} — Ref: ${reference}`);

      ok(res, {
        merchant_id, business_name: merchant.businessName, direction,
        amount: koboToNaira(amt), new_balance: koboToNaira(out.after), reference,
      }, `${direction === 'debit' ? 'Debited' : 'Credited'} ₦${koboToNaira(amt).toLocaleString()} ${direction === 'debit' ? 'from' : 'to'} ${merchant.businessName}`);
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

      // ── Single merchant balance; SA decides the rail (manual phase) ─────────────
      // Rails are 100% internal. The merchant prepays ONE balance; we debit it
      // atomically here and EVERY batch awaits SA routing — SA allocates the
      // disbursement across rail floats via POST /admin/batches/:id/route.
      const wallet = await prisma.merchantWallet.findFirst({ where: { merchantId } });
      const available = wallet ? wallet.balance : 0n;
      if (available < totalDeduction) {
        return fail(res,
          `Insufficient balance. Available: ₦${koboToNaira(available).toLocaleString('en-NG')}, ` +
          `Required: ₦${koboToNaira(totalDeduction).toLocaleString('en-NG')} ` +
          `(₦${koboToNaira(totalAmount).toLocaleString('en-NG')} payouts + ` +
          `₦${koboToNaira(totalFee).toLocaleString('en-NG')} fee + ` +
          `₦${koboToNaira(totalVat).toLocaleString('en-NG')} VAT).`,
          'INSUFFICIENT_BALANCE'
        );
      }

      const batchRef    = generateRef('PAY');
      const scheduledAt = scheduled_at ? new Date(scheduled_at) : new Date();
      const batchStatus = 'needs_routing';   // SA always decides the rail (manual phase)
      const itemStatus  = 'queued';

      // All-or-nothing: atomic GUARDED single-balance debit (WHERE balance >= amount
      // — blocks concurrent over-spend) + batch + items + ledger in ONE transaction.
      let batchId;
      try {
        await prisma.$transaction(async (tx) => {
          const dec = await tx.$queryRaw`
            UPDATE merchant_wallets
            SET balance = balance - ${totalDeduction}, last_used_at = NOW(), updated_at = NOW()
            WHERE merchant_id = ${merchantId}::uuid AND balance >= ${totalDeduction}
            RETURNING balance`;
          if (!dec.length) throw Object.assign(new Error('Balance changed during processing — please retry'), { _client: true });
          const bAfter  = dec[0].balance;
          const bBefore = bAfter + totalDeduction;
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
                 ${(item.narration && String(item.narration).trim()) ? item.narration : defaultNarration}, ${itemStatus}, ${scheduledAt}, NOW())`;
          }
          await tx.$executeRaw`
            INSERT INTO wallet_ledger
              (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
            VALUES
              (${merchantId}::uuid, NULL, 'DEBIT', ${totalAmount}, ${bBefore}, ${bBefore - totalAmount}, ${batchRef},
               ${'Payout batch to ' + items.length + ' beneficiaries: ' + (description||batchRef)}, ${req.user.id}::uuid, NOW()),
              (${merchantId}::uuid, NULL, 'FEE', ${totalFee}, ${bBefore - totalAmount}, ${bBefore - totalAmount - totalFee}, ${batchRef},
               ${'Paylode payout service fee (' + (feeRate*100).toFixed(2) + '%)'}, ${req.user.id}::uuid, NOW()),
              (${merchantId}::uuid, NULL, 'VAT', ${totalVat}, ${bBefore - totalAmount - totalFee}, ${bAfter}, ${batchRef},
               ${'VAT on payout fee (7.5%)'}, ${req.user.id}::uuid, NOW())`;
        }, { timeout: 30000 });
      } catch (e) {
        if (e && e._client) return fail(res, e.message, 'RETRY');
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
        wallet_balance_after: koboToNaira(available - totalDeduction),
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

// ── GET /api/v1/payouts/admin/wallets — SA: per-merchant single balance ───────
router.get('/admin/wallets', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const wallets = await prisma.merchantWallet.findMany({
      include: { merchant: { select: { businessName: true, merchantCode: true } } },
      orderBy: { balance: 'desc' },
    });
    const out = wallets.map(w => ({
      merchant_id: w.merchantId, business_name: w.merchant.businessName,
      merchant_code: w.merchant.merchantCode,
      balance: Number(w.balance), balance_naira: koboToNaira(w.balance),
      total: Number(w.balance), total_naira: koboToNaira(w.balance),
      last_funded_at: w.lastFundedAt, last_used_at: w.lastUsedAt,
    })).sort((a, b) => b.total - a.total);
    ok(res, out);
  } catch (e) { next(e); }
});

// ── GET /api/v1/payouts/admin/payout-rails — SA: rails + payout flag + OUR float ─
router.get('/admin/payout-rails', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rails = await prisma.paymentRail.findMany({
      select: { id: true, name: true, status: true, payoutEnabled: true, floatBalance: true, floatSyncedAt: true,
                payoutFlatCost: true, dailyValueCap: true, tpsLimit: true, sponsorBank: true },
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
    const { payout_enabled, status, payout_flat_cost, daily_value_cap, tps_limit, sponsor_bank } = req.body;
    const data = {};
    if (payout_enabled !== undefined) data.payoutEnabled = !!payout_enabled;
    if (status !== undefined)         data.status = status;
    // Config (kobo for money fields). daily_value_cap = null clears the cap.
    if (payout_flat_cost !== undefined) data.payoutFlatCost = BigInt(Math.max(0, Math.round(Number(payout_flat_cost))));
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

// ── POST /api/v1/payouts/admin/batches/:id/route — SA routes a queued batch ───
// body.allocations: [{ rail_id, amount(kobo) }] summing to the batch's BENEFICIARY
// total (total_amount — fee+VAT is our revenue, never sent through a rail). Items
// are packed into rails to match the split; each leg is written to the rail
// allocation ledger (rail_disbursements). Guarded against float + daily cap.
router.post('/admin/batches/:id/route', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const batchId = req.params.id;
    const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    if (!allocations.length) return fail(res, 'allocations [{rail_id, amount}] required');

    const batchRows = await prisma.$queryRaw`SELECT * FROM payout_batches WHERE id = ${batchId}::uuid`;
    const batch = batchRows[0];
    if (!batch) return notFound(res, 'Batch');
    if (batch.status !== 'needs_routing') return fail(res, `Batch is not awaiting routing (status: ${batch.status})`);

    const totalAmount = BigInt(batch.total_amount);   // beneficiary total (what rails send)
    const allocTotal  = allocations.reduce((s, a) => s + BigInt(a.amount), 0n);
    if (allocTotal !== totalAmount)
      return fail(res, `Allocations (₦${koboToNaira(allocTotal).toLocaleString('en-NG')}) must sum to the payout total ₦${koboToNaira(totalAmount).toLocaleString('en-NG')} (fee + VAT are not sent through a rail).`);

    // Items to disburse (largest first — first-fit-decreasing packing).
    const items = await prisma.$queryRaw`
      SELECT id, amount, bank_code FROM payout_items WHERE batch_id = ${batchId}::uuid ORDER BY amount DESC`;
    // Pack each item into a rail whose remaining target still covers it.
    const targets = allocations.map(a => ({ rail_id: a.rail_id, remaining: BigInt(a.amount), items: [], sum: 0n }));
    for (const it of items) {
      const amt = BigInt(it.amount);
      let bucket = targets.find(t => t.remaining >= amt) ||
                   targets.slice().sort((x, y) => (y.remaining > x.remaining ? 1 : -1))[0]; // overflow → most room
      bucket.items.push({ id: it.id, amount: amt }); bucket.remaining -= amt; bucket.sum += amt;
    }
    const used = targets.filter(t => t.sum > 0n);

    // Rail config for the allocated rails (cost + cap + payout flag).
    const rails = await prisma.paymentRail.findMany({
      where: { id: { in: used.map(t => t.rail_id) } },
      select: { id: true, name: true, payoutEnabled: true, payoutFlatCost: true, dailyValueCap: true },
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
        // beneficiary amounts PLUS (rail flat cost + 7.5% VAT) × number of transfers.
        const railVatUnit  = (r.payoutFlatCost * 75n) / 1000n;            // 7.5% VAT on the flat cost
        const railCostUnit = r.payoutFlatCost + railVatUnit;             // VAT-inclusive cost per transfer
        const railCostTotal = railCostUnit * BigInt(t.items.length);
        const floatNeeded   = t.sum + railCostTotal;                     // beneficiary total + rail charges
        // GUARDED float debit — never send more than our balance with the rail.
        const dec = await tx.$queryRaw`
          UPDATE payment_rails SET float_balance = float_balance - ${floatNeeded}, updated_at = NOW()
          WHERE id = ${t.rail_id}::uuid AND float_balance >= ${floatNeeded} RETURNING float_balance`;
        if (!dec.length) throw Object.assign(new Error(
          `${r.name} lacks enough float for ₦${koboToNaira(floatNeeded).toLocaleString('en-NG')} (payout ₦${koboToNaira(t.sum).toLocaleString('en-NG')} + rail fees).`), { _client: true });
        // Write a ledger leg per item (rail_cost = base, rail_vat = VAT on it) + tag the item.
        for (const it of t.items) {
          const orderId = `${batch.batch_ref}-${it.id.slice(0, 8)}`;   // unique, ≤32 chars
          await tx.$executeRaw`
            INSERT INTO rail_disbursements
              (payout_item_id, batch_id, merchant_id, rail_id, amount, rail_cost, rail_vat, status, rail_order_id, created_at, updated_at)
            VALUES
              (${it.id}::uuid, ${batchId}::uuid, ${batch.merchant_id}::uuid, ${t.rail_id}::uuid,
               ${it.amount}, ${r.payoutFlatCost}, ${railVatUnit}, 'pending', ${orderId}, NOW(), NOW())`;
          await tx.$executeRaw`UPDATE payout_items SET rail_id = ${t.rail_id}::uuid, status = 'processing' WHERE id = ${it.id}::uuid`;
        }
      }
      await tx.$executeRaw`UPDATE payout_batches SET status = 'processing', rail_id = ${used[0].rail_id}::uuid, updated_at = NOW() WHERE id = ${batchId}::uuid`;
    });

    await logAudit(req.user.id, 'PAYOUT_BATCH_ROUTED', 'payout_batches', batchId, {},
      { allocations: used.map(t => ({ rail_id: t.rail_id, amount: Number(t.sum), items: t.items.length })) }, null, req.ip);
    ok(res, { batch_id: batchId, status: 'processing', rails_used: used.length }, 'Batch routed — ledger legs created');
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
