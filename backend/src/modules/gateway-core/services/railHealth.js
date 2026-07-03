'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Rail health & failure handling (payouts) — rail-agnostic FOUNDATION.
//
//  Each payout rail adapter (added when we integrate a real rail) implements:
//    sendPayout(item)  -> Promise<{ ok:true, providerRef } |
//                                  { ok:false, code, reason, isLowBalance? }>
//      `reason` is the rail's API error message, mapped to a clean string.
//      Set isLowBalance:true if the rail signals insufficient funds.
//    getBalance()      -> Promise<bigint kobo> | null   (OPTIONAL — only if the
//                          rail/bank API exposes our account balance with them.)
//
//  The payout send loop calls recordRailResult() for every item. On a run of
//  failures (or a low-balance signal) SA is emailed once (debounced) with the
//  rail + reason + suggested action (reroute via funding another rail / the
//  routing queue). Rails are NEVER exposed to merchants.
// ─────────────────────────────────────────────────────────────────────────────
const { sendEmail } = require('../../../services/emailService');
const { logAudit } = require('../../../services/auditService');
const { logger } = require('../../../utils/logger');

const OPS_EMAIL          = process.env.OPS_EMAIL || 'product@paylodeservices.com';
const FAILURE_THRESHOLD  = parseInt(process.env.RAIL_FAILURE_THRESHOLD || '3', 10); // consecutive fails before alert
const ALERT_DEBOUNCE_MS  = parseInt(process.env.RAIL_ALERT_DEBOUNCE_MS || String(30 * 60 * 1000), 10); // 30 min
const LOW_BALANCE_KOBO   = BigInt(process.env.RAIL_LOW_BALANCE_KOBO || String(5000000 * 100)); // ₦5m default

// In-memory per-rail health. (Stateless restarts reset counters — that's fine;
// alerts are debounced and incidents are also written to the audit log.)
const state = new Map(); // railId -> { fails, lastAlertAt }

function _st(railId) {
  if (!state.has(railId)) state.set(railId, { fails: 0, lastAlertAt: 0 });
  return state.get(railId);
}

// Email SA about a rail incident (debounced per rail+kind).
async function notifyRailIncident(rail, reason, ctx = {}) {
  const railId = (rail && rail.id) || ctx.railId || 'unknown';
  const railName = (rail && rail.name) || ctx.railName || 'Unknown rail';
  const s = _st(railId);
  const now = Date.now();
  if (now - s.lastAlertAt < ALERT_DEBOUNCE_MS && !ctx.force) return false; // debounce
  s.lastAlertAt = now;

  const action = ctx.suggestedAction ||
    'Review the rail. To keep payouts flowing, fund/route the affected merchant(s) through another payout rail (or use the Routing Queue).';
  const html =
    `<h3>&#9888; Payout rail issue — ${railName}</h3>` +
    `<p><strong>Reason:</strong> ${String(reason || 'Unknown error').replace(/</g, '&lt;')}</p>` +
    (ctx.merchant ? `<p><strong>Merchant:</strong> ${ctx.merchant}</p>` : '') +
    (ctx.balanceNaira != null ? `<p><strong>Our balance on this rail:</strong> ₦${Number(ctx.balanceNaira).toLocaleString('en-NG')}</p>` : '') +
    (ctx.failures != null ? `<p><strong>Consecutive failures:</strong> ${ctx.failures}</p>` : '') +
    `<p><strong>Suggested action:</strong> ${action}</p>` +
    `<p style="color:#888;font-size:12px">${new Date().toISOString()}</p>`;
  sendEmail({ to: OPS_EMAIL, subject: `[Rail Alert] ${railName} — ${ctx.kind || 'failures'}`, html })
    .catch((e) => logger.error({ err: e }, 'rail incident email failed'));
  logAudit(null, 'RAIL_INCIDENT', 'payment_rails', railId, null,
    { railName, reason, kind: ctx.kind || 'failures', failures: ctx.failures, balanceNaira: ctx.balanceNaira }, null, null)
    .catch(() => {});
  logger.warn({ railId, railName, reason }, 'rail incident alert sent');
  return true;
}

// Record one payout send result for a rail; alerts SA on a run of failures.
async function recordRailResult(rail, result, ctx = {}) {
  const railId = (rail && rail.id) || ctx.railId || 'unknown';
  const s = _st(railId);
  if (result && result.ok) { s.fails = 0; return; }
  s.fails += 1;
  const reason = (result && result.reason) || 'Payout failed at rail';
  if (result && result.isLowBalance) {
    await notifyRailIncident(rail, reason, { ...ctx, kind: 'low-balance', failures: s.fails,
      suggestedAction: 'Top up our account at this rail, or reroute the merchant to another funded rail.' });
  } else if (s.fails >= FAILURE_THRESHOLD) {
    await notifyRailIncident(rail, reason, { ...ctx, kind: 'failures', failures: s.fails });
  }
}

// If the rail adapter exposes getBalance(), check it and alert SA when low.
// Call this when failures look balance-related, or on a schedule per rail.
async function checkRailBalanceAndAlert(rail, getBalance) {
  if (typeof getBalance !== 'function') return null; // rail can't report balance
  let bal;
  try { bal = await getBalance(); } catch (e) { logger.error({ err: e }, 'rail getBalance failed'); return null; }
  if (bal == null) return null;
  const balKobo = BigInt(bal);
  if (balKobo < LOW_BALANCE_KOBO) {
    await notifyRailIncident(rail, 'Low balance on our account with this rail', {
      kind: 'low-balance', balanceNaira: Number(balKobo) / 100,
      suggestedAction: 'Top up our account at this rail, or reroute payout traffic to another rail.',
    });
  }
  return balKobo;
}

module.exports = { notifyRailIncident, recordRailResult, checkRailBalanceAndAlert,
                   FAILURE_THRESHOLD, LOW_BALANCE_KOBO };
