'use strict';
// 6-digit PIN gate on merchant-dashboard-initiated payouts (JWT sessions only —
// API-key/SDK submissions never require it, see req.isApiKeyAuth in
// modules/gateway-core/routes/payouts.js requireAuthOrApiKey).
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

// Express middleware: PIN-gates a merchant-dashboard (JWT) payout submission.
// Skipped for API-key/SDK calls (req.isApiKeyAuth) and for non-merchant callers.
async function requirePayoutPinMiddleware(req, res, next) {
  try {
    if (req.isApiKeyAuth) return next();
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
