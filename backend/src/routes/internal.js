'use strict';
/**
 * Paylode — Internal service-to-service routes
 * Auth: x-internal-key header (GOLF_PLATFORM_INTERNAL_KEY env var).
 * These routes are NOT versioned under /api/v1/ — they are exclusively for
 * trusted first-party services (Golf Platform, etc.) running on the same
 * infrastructure and must never be exposed to public clients.
 */
const router  = require('express').Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const { prisma }  = require('../utils/db');
const { logger }  = require('../utils/logger');
const { ok, fail, created, generateApiKey, hashApiKey } = require('../utils/helpers');
const { notifyReceipt } = require('../services/whatsappService');

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');

// ── Auth middleware ───────────────────────────────────────────────────────────
router.use((req, res, next) => {
  const key      = req.headers['x-internal-key'];
  const expected = process.env.GOLF_PLATFORM_INTERNAL_KEY;
  if (!expected) {
    logger.error('GOLF_PLATFORM_INTERNAL_KEY not set — internal routes disabled');
    return res.status(503).json({ status: false, message: 'Internal service not configured', error_code: 'NOT_CONFIGURED' });
  }
  if (!key || key !== expected) {
    return res.status(401).json({ status: false, message: 'Unauthorized', error_code: 'UNAUTHORIZED' });
  }
  next();
});

// ── POST /api/internal/golf/provision-club ────────────────────────────────────
// Creates a Paylode merchant account for a golf club. Idempotent: if a merchant
// already exists for businessEmail, returns its details without re-creating.
router.post('/golf/provision-club', async (req, res, next) => {
  try {
    const { clubName, businessEmail, businessPhone, state, contactName, clubId } = req.body;
    if (!clubName || !businessEmail)
      return fail(res, 'clubName and businessEmail are required', 'VALIDATION_ERROR', 400);

    // Idempotency — reuse existing user/merchant for this email
    const existingUser = await prisma.user.findUnique({
      where: { email: businessEmail },
      include: { merchant: true },
    });
    if (existingUser?.merchant) {
      logger.info({ merchantId: existingUser.merchant.id, clubName }, 'Golf club provision — reusing existing merchant');
      return ok(res, {
        merchantId:   existingUser.merchant.id,
        merchantCode: existingUser.merchant.merchantCode,
        email:        businessEmail,
        reused:       true,
      }, 'Merchant already exists for this club');
    }

    const nameParts   = (contactName || clubName).trim().split(/\s+/);
    const tempPassword = crypto.randomBytes(8).toString('base64url');

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email:            businessEmail,
          passwordHash:     await bcrypt.hash(tempPassword, 10),
          firstName:        nameParts[0] || clubName,
          lastName:         nameParts.slice(1).join(' ') || '',
          role:             'MERCHANT',
          mustChangePassword: false,
        },
      });

      const merchantCode = 'MCH-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const merchant = await tx.merchant.create({
        data: {
          userId:           user.id,
          merchantCode,
          businessName:     clubName,
          businessType:     'Professional Body',
          category:         'Sports Club',
          state:            state || 'Lagos',
          businessEmail,
          businessPhone:    businessPhone || '',
          merchantType:     'social_club',
          kycStatus:        'ACTIVE',
          kycTier:          1,
          isActive:         true,
          liveEnabled:      true,
          cardAcceptanceScope: 'local',
          pipelineStage:    'active',
        },
      });

      // Generate 4 API keys; return the plain-text sk_live (hashed in DB)
      let skLivePlain = null;
      const keyData = [];
      for (const [prefix, isSandbox] of [['sk_live', false], ['pk_live', false], ['sk_test', true], ['pk_test', true]]) {
        const full = generateApiKey(prefix);
        if (prefix === 'sk_live') skLivePlain = full;
        keyData.push({ merchantId: merchant.id, keyHash: hashApiKey(full), keyPrefix: prefix, label: 'Golf Platform auto-provisioned', isSandbox });
      }
      await tx.apiKey.createMany({ data: keyData });

      return { merchant, skLivePlain };
    });

    logger.info({ merchantId: result.merchant.id, clubName, clubId }, 'Golf club merchant provisioned');
    return created(res, {
      merchantId:   result.merchant.id,
      merchantCode: result.merchant.merchantCode,
      sk_live:      result.skLivePlain,
      email:        businessEmail,
      tempPassword,
      reused:       false,
    }, 'Golf club merchant account created');

  } catch (e) { next(e); }
});

// ── GET /api/internal/golf/club/:merchantId/summary ───────────────────────────
// Merchant info + wallet balances across all rails + last 10 live transactions.
router.get('/golf/club/:merchantId/summary', async (req, res, next) => {
  try {
    const { merchantId } = req.params;

    const [merchant, wallets, recentTxns] = await Promise.all([
      prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, businessName: true, merchantCode: true, kycStatus: true, isActive: true, liveEnabled: true, businessEmail: true, businessPhone: true },
      }),
      prisma.merchantWallet.findMany({
        where: { merchantId },
        include: { rail: { select: { name: true, code: true } } },
      }),
      prisma.transaction.findMany({
        where: { merchantId, isSandbox: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, reference: true, amount: true, status: true, channel: true, customerEmail: true, createdAt: true, paidAt: true },
      }),
    ]);

    if (!merchant) return fail(res, 'Merchant not found', 'NOT_FOUND', 404);

    const totalBalance = wallets.reduce((sum, w) => sum + Number(w.balance), 0);

    return ok(res, {
      merchant,
      wallets: wallets.map(w => ({
        railName:     w.rail?.name || 'Unknown',
        railCode:     w.rail?.code,
        balance:      Number(w.balance),
        balanceMajor: Number(w.balance) / 100,
      })),
      totalBalance,
      totalBalanceMajor: totalBalance / 100,
      recentTransactions: recentTxns.map(t => ({
        id:           t.id,
        reference:    t.reference,
        amount:       Number(t.amount),
        amountMajor:  Number(t.amount) / 100,
        status:       t.status,
        channel:      t.channel,
        customerEmail: t.customerEmail,
        createdAt:    t.createdAt,
        paidAt:       t.paidAt,
      })),
    }, 'Club merchant summary');

  } catch (e) { next(e); }
});

// ── POST /api/internal/golf/club/:merchantId/topup-link ───────────────────────
// Creates a Paylode payment link so a member can pay into the club's merchant
// account. Returns the hosted checkout URL.
router.post('/golf/club/:merchantId/topup-link', async (req, res, next) => {
  try {
    const { merchantId } = req.params;
    const { amount, description, memberEmail } = req.body;

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, merchantCode: true, businessName: true, isActive: true },
    });
    if (!merchant || !merchant.isActive)
      return fail(res, 'Merchant not found or inactive', 'MERCHANT_INACTIVE', 400);

    const amountKobo  = amount ? BigInt(Math.round(parseFloat(String(amount)) * 100)) : null;
    const title       = `${merchant.businessName} — Payment`;
    const desc        = description || 'Golf Club Collection via Golf Platform';
    const slug        = crypto.randomBytes(8).toString('base64url');
    const expiresAt   = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.$queryRawUnsafe(
      `INSERT INTO payment_links (merchant_id, slug, title, description, amount, currency, is_reusable, expires_at, charge_vat, customer_phone)
       VALUES ($1::uuid, $2, $3, $4, $5, 'NGN', true, $6, false, $7)`,
      merchantId, slug, title, desc,
      amountKobo,
      expiresAt,
      memberEmail || null
    );

    const url = `${CHECKOUT_BASE}/checkout.html?link=${slug}`;
    logger.info({ merchantId, slug, amountKobo: amountKobo?.toString() }, 'Golf Platform top-up link created');
    return ok(res, { slug, url, merchantCode: merchant.merchantCode }, 'Payment link created');

  } catch (e) { next(e); }
});

// ── POST /api/internal/golf/whatsapp/payment-receipt ─────────────────────────
// Sends a WhatsApp payment receipt to a golf club member.
// Only called when the club has opted into WhatsApp notifications (SA toggle).
// Amount must be in kobo (multiply naira × 100 on the caller's side).
// Non-fatal: if the template env var is unset or Meta rejects, logs and returns ok=false.
router.post('/golf/whatsapp/payment-receipt', async (req, res, next) => {
  try {
    const { phone, memberName, clubName, amountKobo, reference, merchantId } = req.body;
    if (!phone || !amountKobo || !reference)
      return fail(res, 'phone, amountKobo and reference are required', 'VALIDATION_ERROR', 400);

    const result = await notifyReceipt({
      phone,
      recipientName: memberName || 'Member',
      businessName:  clubName   || 'Golf Club',
      invoiceNumber: reference,
      amount:        amountKobo,
      currency:      'NGN',
      merchantId:    merchantId || null,
    });

    logger.info({ phone, reference, ok: result?.ok, skipped: result?.skipped }, 'Golf WA payment receipt');
    return ok(res, { ok: !(result?.skipped), skipped: result?.skipped || false }, 'WhatsApp send attempted');
  } catch (e) { next(e); }
});

// ── POST /api/internal/system/cert-alert ─────────────────────────────────────
// Called by the cert-monitor cron on servers 45 and 176. Sends an email alert.
// Body: { server, domain, status, daysLeft, message }
router.post('/system/cert-alert', async (req, res, next) => {
  try {
    const { sendEmail } = require('../services/emailService');
    const { server = 'unknown', domain = '', status = '', daysLeft, message = '' } = req.body;
    const isRenewed = status === 'renewed';
    const subject = isRenewed
      ? `[Paylode] SSL cert renewed — ${domain}`
      : `[Paylode] ALERT: SSL cert expiring in ${daysLeft} days — ${domain}`;
    const colour = isRenewed ? '#6dc42a' : '#d94f4f';
    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f5f8fd;margin:0;padding:20px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
<div style="background:#0a1a35;padding:20px 28px"><h1 style="margin:0;font-size:20px;color:#fff">Pay<span style="color:#6dc42a">lode</span> — SSL Monitor</h1></div>
<div style="padding:24px 28px">
<p style="font-size:15px;font-weight:700;color:${colour};margin:0 0 16px">${subject}</p>
<table style="font-size:13px;border-collapse:collapse;width:100%">
<tr><td style="padding:4px 0;color:#7a8fa8;width:100px">Server</td><td style="padding:4px 0;font-weight:600">${server}</td></tr>
<tr><td style="padding:4px 0;color:#7a8fa8">Domain</td><td style="padding:4px 0;font-weight:600">${domain}</td></tr>
<tr><td style="padding:4px 0;color:#7a8fa8">Status</td><td style="padding:4px 0;font-weight:600">${status}</td></tr>
${daysLeft != null ? `<tr><td style="padding:4px 0;color:#7a8fa8">Days left</td><td style="padding:4px 0;font-weight:600">${daysLeft}</td></tr>` : ''}
</table>
${message ? `<p style="font-size:13px;color:#4a5b70;margin-top:16px">${message}</p>` : ''}
</div></div></body></html>`;
    await sendEmail({ to: 'gokeakinboro@gmail.com', subject, html });
    logger.info({ domain, status, daysLeft }, 'cert-alert email sent');
    return ok(res, { sent: true });
  } catch (e) { next(e); }
});

module.exports = router;
