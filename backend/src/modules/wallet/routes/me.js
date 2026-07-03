'use strict';
// Member self-service (the member app/web). Authenticated as the logged-in member.
// Unifies wallet activity + invoices addressed to the member, and lets them fund,
// spend across departments, and pay invoices from their wallet balance.
const bcrypt = require('bcryptjs');
const router = require('express').Router();
const { prisma, memberAuth, getConfig, normalizePhone, isValidEmail } = require('../_shared');
const { ok, fail, created, notFound } = require('../../../utils/helpers');
const { createCheckoutTransaction } = require('../../gateway-core/services/gatewayTxn');
const compliance = require('../../../services/complianceService');
const ledger = require('../services/ledger');
const walletPush = require('../services/walletPush');
const { payInvoiceFromWallet } = require('../services/walletInvoice');

router.use(memberAuth);
const num = (v) => (v == null ? null : Number(v));

// All clubs this login belongs to (for the in-app club switcher). The active one
// (per X-Member-Id / default) is flagged. Client sends X-Member-Id to switch.
router.get('/memberships', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT m.id::text AS member_id, m.status, w.balance::text AS balance, w.currency,
              COALESCE(NULLIF(c.brand_name, ''), mer.business_name) AS club_name, c.brand_color
         FROM mw_members m
         JOIN mw_wallets w ON w.member_id = m.id
         JOIN merchants mer ON mer.id = m.merchant_id
         LEFT JOIN mw_config c ON c.merchant_id = m.merchant_id
        WHERE m.user_id = $1::uuid AND m.status <> 'deleted'
        ORDER BY club_name`, req.user.id);
    return ok(res, rows.map((r) => ({
      member_id: r.member_id, club_name: r.club_name, balance: num(r.balance),
      currency: r.currency || 'NGN', status: r.status, brand_color: r.brand_color || null,
      active: r.member_id === req.walletMember.member_id,
    })));
  } catch (e) { next(e); }
});
function handle(res, e, next) { if (e && e.name === 'WalletError') return fail(res, e.message, e.code, e.status); next(e); }

// ── Transaction PIN (app-unlock + per-payment authorization) ──────────────────
const PIN_MAX_FAILS = 5, PIN_LOCK_MIN = 15;
const pinErr = (message, code, status = 401) => Object.assign(new Error(message), { name: 'WalletError', code, status });

// Verify the PIN supplied on this request (req.body.pin). Enforces a lockout after
// repeated wrong attempts. Throws a WalletError (mapped by handle()) on any failure.
async function assertPin(req) {
  const m = req.walletMember;
  if (!m.pin_hash) throw pinErr('Set up your transaction PIN first', 'PIN_NOT_SET', 403);
  if (m.pin_locked_until && new Date(m.pin_locked_until) > new Date())
    throw pinErr('Too many wrong PIN attempts. Try again later.', 'PIN_LOCKED', 429);
  const pin = String(req.body.pin || '');
  const good = /^\d{4,6}$/.test(pin) && await bcrypt.compare(pin, m.pin_hash);
  if (!good) {
    const fails = (m.pin_failed || 0) + 1;
    const lock = fails >= PIN_MAX_FAILS;
    await prisma.$executeRawUnsafe(
      `UPDATE mw_members SET pin_failed=$1, pin_locked_until=$2 WHERE id=$3::uuid`,
      lock ? 0 : fails, lock ? new Date(Date.now() + PIN_LOCK_MIN * 60000) : null, m.member_id);
    throw lock
      ? pinErr(`Too many wrong PIN attempts. Try again in ${PIN_LOCK_MIN} minutes.`, 'PIN_LOCKED', 429)
      : pinErr(`Incorrect PIN. ${PIN_MAX_FAILS - fails} attempt(s) left.`, 'PIN_WRONG', 401);
  }
  if (m.pin_failed) await prisma.$executeRawUnsafe(`UPDATE mw_members SET pin_failed=0, pin_locked_until=NULL WHERE id=$1::uuid`, m.member_id);
}

// Invoices addressed to this member (matched by email/phone within the merchant).
function memberInvoiceWhere(m) {
  const parts = []; const vals = [m.merchant_id]; let i = 2;
  if (m.email) { parts.push(`lower(recipient_email) = $${i++}`); vals.push(m.email.toLowerCase()); }
  if (m.phone) { parts.push(`recipient_phone = $${i++}`); vals.push(m.phone); }
  return { clause: parts.length ? `(${parts.join(' OR ')})` : 'false', vals };
}

router.get('/', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const cfg = await getConfig(m.merchant_id);
    return ok(res, {
      member: { id: m.member_id, name: m.name, email: m.email, phone: m.phone },
      pin_set: !!m.pin_hash,
      wallet: { id: m.wallet_id, balance: num(m.balance), currency: m.currency, low_balance_threshold: num(m.low_balance_threshold) },
      branding: { name: cfg.brand_name || 'Billspay', logo_url: cfg.brand_logo_url || null, color: cfg.brand_color || '#1a2744' },
    });
  } catch (e) { next(e); }
});

// Edit own profile: name, phone, and email. Email is the LOGIN identity, so it is
// updated on the users row too (uniqueness-checked) and kept in sync on mw_members.
router.patch('/profile', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const updates = {};                                   // mw_members fields to set
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return fail(res, 'Name cannot be empty');
      updates.name = name;
    }
    if (req.body.phone !== undefined) {
      const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
      if (req.body.phone && !phone) return fail(res, 'Enter a valid phone number');
      updates.phone = phone;
    }
    let newEmail = null;
    if (req.body.email !== undefined) {
      const e = String(req.body.email || '').trim().toLowerCase();
      if (!isValidEmail(e)) return fail(res, 'Enter a valid email address');
      if (e !== String(m.email || '').toLowerCase()) {
        const clash = await prisma.user.findUnique({ where: { email: e } });
        if (clash && clash.id !== req.user.id) return fail(res, 'That email is already in use', 'EMAIL_TAKEN', 409);
        newEmail = e;
      }
    }
    if (!Object.keys(updates).length && !newEmail) return fail(res, 'Nothing to update');

    await prisma.$transaction(async (tx) => {
      if (newEmail) { await tx.user.update({ where: { id: req.user.id }, data: { email: newEmail } }); updates.email = newEmail; }
      const sets = []; const vals = []; let i = 1;
      for (const k of ['name', 'phone', 'email']) {
        if (updates[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(updates[k]); }
      }
      if (sets.length) {
        vals.push(m.member_id);
        await tx.$executeRawUnsafe(`UPDATE mw_members SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i}::uuid`, ...vals);
      }
    });

    const fresh = { ...m, ...updates };
    return ok(res, { member: { id: m.member_id, name: fresh.name, email: fresh.email, phone: fresh.phone } }, 'Profile updated');
  } catch (e) { next(e); }
});

// Set or change the transaction PIN. Requires the account password to authorize.
router.post('/pin', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const pin = String(req.body.pin || '');
    if (!/^\d{4,6}$/.test(pin)) return fail(res, 'PIN must be 4 to 6 digits', 'PIN_INVALID');
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !await bcrypt.compare(String(req.body.password || ''), user.passwordHash))
      return fail(res, 'Your account password is incorrect', 'BAD_PASSWORD', 401);
    const hash = await bcrypt.hash(pin, 12);
    await prisma.$executeRawUnsafe(
      `UPDATE mw_members SET pin_hash=$1, pin_set_at=now(), pin_failed=0, pin_locked_until=NULL WHERE id=$2::uuid`, hash, m.member_id);
    return ok(res, { pin_set: true }, 'Transaction PIN set');
  } catch (e) { next(e); }
});

// Verify the PIN — used to unlock the app and as the biometric/payment gate. Body: { pin }.
router.post('/pin/verify', async (req, res, next) => {
  try { await assertPin(req); return ok(res, { ok: true }, 'PIN verified'); }
  catch (e) { handle(res, e, next); }
});

// Web-push (PWA notifications): public key + subscribe / unsubscribe.
router.get('/push/key', (req, res) => ok(res, { key: walletPush.publicKey() }));
router.post('/push', async (req, res, next) => {
  try { await walletPush.subscribe(req.walletMember.member_id, req.body && req.body.subscription); return ok(res, { subscribed: true }, 'Notifications enabled'); }
  catch (e) { next(e); }
});
router.delete('/push', async (req, res, next) => {
  try { await walletPush.unsubscribe(req.body && req.body.endpoint); return ok(res, { unsubscribed: true }); }
  catch (e) { next(e); }
});

// Departments the member can pay (spend targets).
router.get('/departments', async (req, res, next) => {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name FROM inv_departments WHERE merchant_id = $1::uuid ORDER BY name`, req.walletMember.merchant_id);
    return ok(res, rows);
  } catch (e) { next(e); }
});

// Unified transaction history: wallet ledger entries + invoices to this member.
router.get('/transactions', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const led = await prisma.$queryRawUnsafe(
      `SELECT created_at, type, direction, amount::text AS amount, balance_after::text AS balance_after, reference,
              department_id::text AS department_id, note
         FROM mw_ledger WHERE wallet_id = $1::uuid ORDER BY created_at DESC LIMIT 200`, m.wallet_id);
    const iw = memberInvoiceWhere(m);
    const inv = await prisma.$queryRawUnsafe(
      `SELECT created_at, invoice_number, description, total_amount::text AS total_amount, amount_paid::text AS amount_paid,
              status, id::text AS id FROM inv_invoices WHERE merchant_id = $1::uuid AND ${iw.clause}
         ORDER BY created_at DESC LIMIT 200`, ...iw.vals);
    const feed = [
      ...led.map((l) => ({ kind: 'wallet', date: l.created_at, type: l.type, direction: l.direction,
        amount: num(l.amount), balance_after: num(l.balance_after), reference: l.reference, note: l.note })),
      ...inv.map((v) => ({ kind: 'invoice', date: v.created_at, invoice_id: v.id, invoice_number: v.invoice_number,
        description: v.description, amount: num(v.total_amount), amount_paid: num(v.amount_paid), status: v.status })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 300);
    return ok(res, feed);
  } catch (e) { next(e); }
});

// Invoices addressed to this member.
router.get('/invoices', async (req, res, next) => {
  try {
    const m = req.walletMember; const iw = memberInvoiceWhere(m);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, invoice_number, description, total_amount::text AS total_amount, amount_paid::text AS amount_paid,
              status, due_at, department_id::text AS department_id, created_at
         FROM inv_invoices WHERE merchant_id = $1::uuid AND ${iw.clause} ORDER BY created_at DESC LIMIT 200`, ...iw.vals);
    return ok(res, rows.map((r) => ({ ...r, total_amount: num(r.total_amount), amount_paid: num(r.amount_paid) })));
  } catch (e) { next(e); }
});

// Pay an invoice from the wallet (wallet can never go negative).
router.post('/invoices/:id/pay', async (req, res, next) => {
  try {
    const m = req.walletMember;
    await assertPin(req);
    const r = await payInvoiceFromWallet({
      walletId: m.wallet_id, invoiceId: req.params.id, merchantId: m.merchant_id,
      amount: req.body.amount != null ? parseInt(req.body.amount, 10) : null, createdBy: req.user.id,
    });
    return ok(res, r, 'Invoice paid from wallet');
  } catch (e) { handle(res, e, next); }
});

// Fund own wallet via the hosted checkout.
router.post('/fund', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 10000) return fail(res, 'amount must be in kobo, minimum ₦100 (10000 kobo)');
    const cfg = await getConfig(m.merchant_id);
    if (BigInt(m.balance) + BigInt(amount) > cfg.max_balance)
      return fail(res, `Funding would exceed your ₦${(Number(cfg.max_balance) / 100).toLocaleString()} wallet ceiling`, 'MAX_BALANCE_EXCEEDED', 409);
    const merchant = await prisma.merchant.findUnique({ where: { id: m.merchant_id }, include: { aggregator: true } });
    if (!merchant || !merchant.isActive) return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);
    const gate = compliance.screenTransaction(merchant, { customerEmail: m.email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);
    const { reference, redirectUrl } = await createCheckoutTransaction({
      merchantId: m.merchant_id, amount, currency: 'NGN', customerEmail: m.email || '', refPrefix: 'WLTFUND',
      source: 'wallet_fund', metadata: { description: `Wallet top-up`, wallet_id: m.wallet_id, member_id: m.member_id },
    });
    return created(res, { reference, redirect_url: redirectUrl }, 'Funding started');
  } catch (e) { next(e); }
});

// Spend to a department.
router.post('/spend', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1) return fail(res, 'A valid amount (kobo) is required');
    if (!req.body.department_id) return fail(res, 'department_id is required');
    const d = await prisma.$queryRawUnsafe(`SELECT id::text FROM inv_departments WHERE id=$1::uuid AND merchant_id=$2::uuid`, req.body.department_id, m.merchant_id);
    if (!d.length) return fail(res, 'Invalid department');
    await assertPin(req);
    const r = await ledger.spendToDepartment({ walletId: m.wallet_id, departmentId: req.body.department_id, amount, createdBy: req.user.id, note: req.body.note ? String(req.body.note).slice(0, 200) : null });
    require('../services/walletNotify').memberSpent({ merchantId: m.merchant_id, walletId: m.wallet_id, departmentId: req.body.department_id, amount, balanceAfter: r.balanceAfter }).catch(() => {});
    return ok(res, { reference: r.reference, wallet_balance: Number(r.balanceAfter) }, 'Payment successful');
  } catch (e) { handle(res, e, next); }
});

// ── SCAN & PAY ───────────────────────────────────────────────────────────────
// A member scans a merchant/department QR (inv_qr_codes) in the wallet app. Closed-loop:
// the QR MUST belong to the member's own merchant. Resolve returns the bill; pay debits
// the wallet (never negative) and credits the department.
const VAT_RATE = 0.075;
async function resolveQr(m, token) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT q.id::text, q.qr_reference, q.label, q.type, q.amount::text AS amount, q.charge_vat,
            q.is_active, q.merchant_id::text AS merchant_id, q.department_id::text AS department_id,
            d.name AS department_name
       FROM inv_qr_codes q LEFT JOIN inv_departments d ON d.id = q.department_id
      WHERE q.access_token = $1`, token);
  if (!rows.length) return { error: 'This QR code is not recognised', code: 'QR_NOT_FOUND', status: 404 };
  const q = rows[0];
  if (q.merchant_id !== m.merchant_id) return { error: 'This wallet can only pay codes from your own organisation', code: 'QR_OUT_OF_NETWORK', status: 403 };
  if (!q.is_active) return { error: 'This QR code is no longer active', code: 'QR_INACTIVE', status: 409 };
  return { qr: {
    id: q.id, reference: q.qr_reference, label: q.label, type: q.type,
    amount: q.amount === null ? null : num(q.amount), charge_vat: !!q.charge_vat,
    department_id: q.department_id, department_name: q.department_name || null,
  }};
}

// GET /wallet/me/qr/:token — resolve a scanned QR into a payable bill.
router.get('/qr/:token', async (req, res, next) => {
  try {
    const r = await resolveQr(req.walletMember, String(req.params.token));
    if (r.error) return fail(res, r.error, r.code, r.status);
    return ok(res, r.qr);
  } catch (e) { next(e); }
});

// POST /wallet/me/qr/:token/pay — pay a scanned QR from the wallet (never goes negative).
// Fixed QR → the preset amount; open QR → the member-entered amount (body.amount, kobo). VAT added if the QR charges it.
router.post('/qr/:token/pay', async (req, res, next) => {
  try {
    const m = req.walletMember;
    const r = await resolveQr(m, String(req.params.token));
    if (r.error) return fail(res, r.error, r.code, r.status);
    const q = r.qr;
    const base = q.type === 'fixed' ? q.amount : parseInt(req.body.amount, 10);
    if (!Number.isInteger(base) || base < 1)
      return fail(res, q.type === 'fixed' ? 'This QR has no valid amount' : 'Enter a valid amount to pay');
    const vat = q.charge_vat ? Math.round(base * VAT_RATE) : 0;
    const amount = base + vat;
    await assertPin(req);
    let result;
    if (q.department_id) {
      result = await ledger.spendToDepartment({ walletId: m.wallet_id, departmentId: q.department_id, amount, createdBy: req.user.id, note: q.label || ('QR ' + q.reference) });
      require('../services/walletNotify').memberSpent({ merchantId: m.merchant_id, walletId: m.wallet_id, departmentId: q.department_id, amount, balanceAfter: result.balanceAfter }).catch(() => {});
    } else {
      result = await ledger.debit({ walletId: m.wallet_id, amount, type: 'spend', counterparty: q.reference, note: q.label || ('QR ' + q.reference), createdBy: req.user.id });
    }
    return ok(res, { reference: result.reference, wallet_balance: Number(result.balanceAfter), paid: amount, base, vat,
      label: q.label, department: q.department_name || null }, 'Payment successful');
  } catch (e) { handle(res, e, next); }
});

module.exports = router;
