'use strict';
// 6-digit PIN gate on merchant-dashboard-initiated payouts ONLY. Never applies
// to payouts submitted via the API — that includes sk_live_/sk_test_ API-key
// calls (req.isApiKeyAuth, see requireAuthOrApiKey) AND JWT-authenticated
// programmatic callers that log in and post directly (e.g. a merchant's own
// server hitting /payouts/batches with a Java/Python/etc HTTP client) rather
// than a browser hitting our dashboard. A same-origin Referer/Origin check
// distinguishes the two — see isDashboardOrigin(). Found 2026-09-30 when this
// gate broke a live automated payout integration that authenticates via JWT
// but is not our dashboard; must never regress.
//
// Setting/changing/resetting the PIN all require a fresh password (+2FA, if
// enabled) step-up via services/reauth.js — there's no separate email-token
// reset flow. Verifying the PIN at payout time is a plain bcrypt compare, with
// a lockout after repeated wrong attempts so a stolen session can't be brute-
// forced into a payout.

const bcrypt = require('bcryptjs');
const { prisma } = require('../utils/db');

const PIN_REGEX = /^\d{6}$/;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 30;

function isValidPin(pin) {
  return typeof pin === 'string' && PIN_REGEX.test(pin);
}

async function getPinState(merchantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT payout_pin_hash, payout_pin_set_at, payout_pin_failed_attempts, payout_pin_locked_until
       FROM merchants WHERE id = $1::uuid`,
    merchantId,
  );
  return rows[0] || null;
}

async function hasPinSet(merchantId) {
  const state = await getPinState(merchantId);
  return !!(state && state.payout_pin_hash);
}

// Sets (or overwrites) the PIN. Caller must already have verified the step-up
// password/2FA before calling this — this function does not re-check identity.
async function setPin(merchantId, newPin) {
  if (!isValidPin(newPin)) return { ok: false, code: 'INVALID_PIN', error: 'PIN must be exactly 6 digits' };
  const hash = await bcrypt.hash(newPin, 12);
  await prisma.$executeRawUnsafe(
    `UPDATE merchants
        SET payout_pin_hash = $1, payout_pin_set_at = NOW(),
            payout_pin_failed_attempts = 0, payout_pin_locked_until = NULL
      WHERE id = $2::uuid`,
    hash, merchantId,
  );
  return { ok: true };
}

// Verifies a PIN at payout-submission time. Locks out after MAX_ATTEMPTS wrong
// tries for LOCK_MINUTES. Resets the counter on a correct entry.
async function verifyPin(merchantId, pin) {
  const state = await getPinState(merchantId);
  if (!state || !state.payout_pin_hash) return { ok: false, code: 'PIN_NOT_SET', error: 'Set a payout PIN before submitting a payout' };

  if (state.payout_pin_locked_until && new Date(state.payout_pin_locked_until) > new Date()) {
    return {
      ok: false, code: 'PIN_LOCKED',
      error: `Too many wrong PIN attempts. Try again after ${new Date(state.payout_pin_locked_until).toISOString()}`,
      lockedUntil: state.payout_pin_locked_until,
    };
  }

  if (!isValidPin(pin)) return { ok: false, code: 'INVALID_PIN', error: 'PIN must be exactly 6 digits' };

  const match = await bcrypt.compare(pin, state.payout_pin_hash);
  if (match) {
    if (state.payout_pin_failed_attempts > 0 || state.payout_pin_locked_until) {
      await prisma.$executeRawUnsafe(
        `UPDATE merchants SET payout_pin_failed_attempts = 0, payout_pin_locked_until = NULL WHERE id = $1::uuid`,
        merchantId,
      );
    }
    return { ok: true };
  }

  const attempts = Number(state.payout_pin_failed_attempts || 0) + 1;
  const lockNow = attempts >= MAX_ATTEMPTS;
  await prisma.$executeRawUnsafe(
    `UPDATE merchants
        SET payout_pin_failed_attempts = $1,
            payout_pin_locked_until = ${lockNow ? `NOW() + INTERVAL '${LOCK_MINUTES} minutes'` : 'payout_pin_locked_until'}
      WHERE id = $2::uuid`,
    attempts, merchantId,
  );
  if (lockNow) {
    return { ok: false, code: 'PIN_LOCKED', error: `Too many wrong PIN attempts. Locked for ${LOCK_MINUTES} minutes.` };
  }
  return { ok: false, code: 'WRONG_PIN', error: 'Incorrect PIN', attemptsRemaining: MAX_ATTEMPTS - attempts };
}

// Our own dashboard's browser origins — the ONLY origins the PIN gate applies to.
const DASHBOARD_HOSTS = ['paylodeservices.com', 'www.paylodeservices.com', 'billspay.net', 'www.billspay.net'];

// True only when the request's Origin/Referer is our dashboard's browser host.
// A missing Origin/Referer (the norm for server-to-server / SDK / script
// callers) is NOT the dashboard, so it returns false and the PIN is skipped.
function isDashboardOrigin(req) {
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return false;
  try {
    const host = new URL(src).hostname;
    return DASHBOARD_HOSTS.includes(host) || host === 'localhost' || host === '127.0.0.1';
  } catch (_) { return false; }
}

// Express middleware: PIN-gates a merchant-dashboard (browser) payout submission.
// Skipped for API-key/SDK calls (req.isApiKeyAuth), for non-merchant callers,
// and for any JWT-authenticated request that isn't actually from our dashboard
// (e.g. a merchant's own server logging in and posting programmatically).
async function requirePayoutPinMiddleware(req, res, next) {
  try {
    if (req.isApiKeyAuth) return next();
    if (!isDashboardOrigin(req)) return next();
    if (!req.user || req.user.role !== 'MERCHANT') return next();
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return next();

    const pin = req.body && req.body.payout_pin;
    const result = await verifyPin(merchantId, pin);
    if (!result.ok) {
      const status = result.code === 'PIN_NOT_SET' ? 400 : 401;
      return res.status(status).json({ status: false, message: result.error, error_code: result.code });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { isValidPin, hasPinSet, setPin, verifyPin, requirePayoutPinMiddleware, MAX_ATTEMPTS, LOCK_MINUTES };
