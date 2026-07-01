'use strict';
// Public (UNAUTHENTICATED) Paymula endpoints for member self-registration.
//   GET  /api/v1/wallet/public/clubs      — opted-in + enabled club directory
//   POST /api/v1/wallet/public/register   — member self-registration + KYC verify
// Read paths carry no funds/PII. Register is rate-limited + KYC-gated.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { prisma, isValidEmail, normalizePhone, hashPassword, getConfig } = require('../_shared');
const { ok, fail, created } = require('../../../utils/helpers');
const { verifyNin, verifyBvn } = require('../../../services/youverifyService');

// GET /clubs?q=<search> — clubs that opted into public members and are enabled.
router.get('/clubs', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    let sql = `SELECT m.id::text AS id,
                      COALESCE(NULLIF(c.brand_name, ''), m.business_name) AS name,
                      c.brand_logo_url, c.brand_color, m.category, m.state
                 FROM mw_config c
                 JOIN merchants m ON m.id = c.merchant_id
                WHERE c.allow_public_members = true AND c.enabled = true`;
    const vals = [];
    if (q) { sql += ` AND lower(COALESCE(NULLIF(c.brand_name, ''), m.business_name)) LIKE $1`; vals.push('%' + q + '%'); }
    sql += ` ORDER BY name ASC LIMIT 100`;
    return ok(res, await prisma.$queryRawUnsafe(sql, ...vals));
  } catch (e) { next(e); }
});

// Abuse/cost guard — each register attempt can trigger paid KYC lookups.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { status: false, message: 'Too many sign-up attempts. Please try again later.', error_code: 'RATE_LIMIT' },
});

// POST /register — join a club as a member. Body: { merchant_id, name, email, phone,
// password, nin, bvn, address }. Verifies NIN + BVN before creating the account.
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const phone = b.phone ? normalizePhone(b.phone) : null;
    const password = String(b.password || '');
    const nin = String(b.nin || '').trim();
    const bvn = String(b.bvn || '').trim();
    const address = String(b.address || '').trim();
    const merchantId = String(b.merchant_id || '').trim();

    if (!name || !isValidEmail(email) || password.length < 8 || !address || !merchantId)
      return fail(res, 'Name, a valid email, a password (8+ chars), address and a club are required');
    if (b.phone && !phone) return fail(res, 'Invalid phone number');
    if (!/^\d{11}$/.test(nin) || !/^\d{11}$/.test(bvn))
      return fail(res, 'A valid 11-digit NIN and BVN are required');

    // Club must be open for public sign-up (opted-in + enabled).
    const club = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(c.brand_name,''), m.business_name) AS name
         FROM mw_config c JOIN merchants m ON m.id = c.merchant_id
        WHERE c.merchant_id = $1::uuid AND c.allow_public_members = true AND c.enabled = true`, merchantId);
    if (!club.length) return fail(res, 'This club is not open for public sign-up', 'CLUB_NOT_OPEN', 400);

    // One login per email. (Joining additional clubs = multi-club membership, later.)
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } }))
      return fail(res, 'An account with this email already exists — please sign in.', 'EMAIL_EXISTS', 409);

    // KYC — verify identity before creating anything.
    const [ninR, bvnR] = await Promise.all([verifyNin(nin), verifyBvn(bvn)]);
    if (!ninR.success) return fail(res, 'We could not verify that NIN. Please check and try again.', 'NIN_UNVERIFIED', 422);
    if (!bvnR.success) return fail(res, 'We could not verify that BVN. Please check and try again.', 'BVN_UNVERIFIED', 422);

    const [firstName, ...rest] = name.split(' ');
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), firstName: firstName || name,
              lastName: rest.join(' ') || '-', role: 'MERCHANT', permissions: [], mustChangePassword: false },
      select: { id: true },
    });
    const mrows = await prisma.$queryRawUnsafe(
      `INSERT INTO mw_members (merchant_id, user_id, name, email, phone, kyc_tier, nin, bvn, address, kyc_verified, kyc_verified_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,'full',$6,$7,$8,true,now()) RETURNING id::text`,
      merchantId, user.id, name, email, phone, nin, bvn, address);
    const cfg = await getConfig(merchantId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO mw_wallets (merchant_id, member_id, low_balance_threshold) VALUES ($1::uuid,$2::uuid,$3)`,
      merchantId, mrows[0].id, cfg.low_balance_default);

    return created(res, { member_id: mrows[0].id, email, club: club[0].name }, 'Account created — you can now sign in.');
  } catch (e) { next(e); }
});

module.exports = router;
