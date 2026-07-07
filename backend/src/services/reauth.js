'use strict';
// Step-up re-authentication for sensitive self-service actions (e.g. revealing or
// rotating a webhook signing secret). Verifies the caller's password again and,
// when they have 2FA enabled, a fresh TOTP code — so a hijacked session alone
// can't lift a secret. Self-contained (mirrors the TOTP logic in routes/auth.js)
// to avoid coupling to the auth router.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { prisma } = require('../utils/db');

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32Decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHA.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', b32Decode(secret)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off+1] << 16) | (hmac[off+2] << 8) | hmac[off+3];
  return String(code % 1000000).padStart(6, '0');
}
function verifyTOTP(secret, token, window = 1) {
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (totpCode(secret, step + i) === String(token).replace(/\s/g, '')) return true;
  }
  return false;
}

// Returns { ok:true } on success, else { ok:false, error, code }.
//   code TWOFA_REQUIRED → caller has 2FA on but sent no code (prompt for it).
async function reauthenticate(userId, { password, code } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, totpEnabled: true, totpSecret: true },
  });
  if (!user) return { ok: false, error: 'User not found', code: 'NO_USER' };
  if (!password || !await bcrypt.compare(password, user.passwordHash))
    return { ok: false, error: 'Password is incorrect', code: 'BAD_PASSWORD' };
  if (user.totpEnabled && user.totpSecret) {
    if (!code) return { ok: false, error: '2FA code required', code: 'TWOFA_REQUIRED' };
    if (!verifyTOTP(user.totpSecret, code)) return { ok: false, error: 'Invalid 2FA code', code: 'BAD_TWOFA' };
  }
  return { ok: true };
}

module.exports = { reauthenticate, verifyTOTP };
