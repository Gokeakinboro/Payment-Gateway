'use strict';
/**
 * Paylode Rail Pre-funding Cron
 *
 * Runs daily at 6am (and immediately on startup).
 *
 * For each LIVE payout rail (except Parallex, which is the source):
 *   1. Determine which destination bank codes are on-us for this rail
 *      (via ON_US_CODES_BY_RAIL — same map as the smart router in payouts.js)
 *   2. Query payout_items for cumulative txn count + volume to those bank codes
 *      over the last HISTORY_DAYS. This is DESTINATION-BANK based (real demand),
 *      not rail_disbursements based (historical routing, which may be biased toward
 *      old routing before smart routing was active).
 *   3. Target float = avg_daily_volume × 2 days × 1.5 safety buffer
 *   4. If current float < target: top up via Parallex NIP to rail's settlement account
 *   5. Email summary when top-ups are done
 *
 * Adding a new rail:
 *   1. Add its on-us bank codes to ON_US_CODES_BY_RAIL below (mirrors payouts.js)
 *   2. Add its settlement account to RAIL_SETTLEMENT below
 *   3. Insert its row into payment_rails — cron auto-includes it next run
 */
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/.prisma/client');
const { sendEmail }    = require('/opt/paylode-api/backend/src/services/emailService');
const parallexTransfer = require('/opt/paylode-api/backend/src/modules/gateway-core/services/parallexTransferService');
const { logger }       = require('/opt/paylode-api/backend/src/utils/logger');

const p = new PrismaClient();
const ALERT_TO = 'gokeakinboro@gmail.com';

// ── ON_US_CODES_BY_RAIL ───────────────────────────────────────────────────────
// Keep in sync with payouts.js. Maps rail name keywords → on-us bank codes.
// "On-us" = destination settles internally on that rail's own network (no NIP).
const ON_US_CODES_BY_RAIL = {
  palmpay:  ['100033'],
  opay:     ['100004', '328'],
  // Add new rails here as they go live, e.g.:
  // gtbank:   ['000013', '058'],
  // access:   ['000014', '044'],
};

// ── RAIL_SETTLEMENT ───────────────────────────────────────────────────────────
// Paylode's settlement (merchant) accounts with each rail provider.
// Parallex NIP sends money to these accounts to top up the rail float.
const RAIL_SETTLEMENT = {
  palmpay: {
    bank_code:      '100033',
    account_number: '8882777449',
    account_name:   'PalmPay',
  },
  opay: {
    bank_code:      process.env.OPAY_SETTLE_BANK    || '',
    account_number: process.env.OPAY_SETTLE_ACCOUNT || '',
    account_name:   'OPay',
  },
};

// ── Config ────────────────────────────────────────────────────────────────────
const HISTORY_DAYS   = 14;    // days of payout_items history to use for projection
const BUFFER_MULT    = 1.5;   // safety multiplier on top of 2-day avg demand
const MIN_FLOAT_KOBO = BigInt(2_000_000);   // ₦20,000 minimum float on any live rail
const MIN_TOPUP_KOBO = BigInt(500_000);     // ₦5,000 minimum top-up (avoid noise transfers)

// ── Helpers ───────────────────────────────────────────────────────────────────

function onUsCodesFor(railName) {
  const lower = (railName || '').toLowerCase();
  for (const [key, codes] of Object.entries(ON_US_CODES_BY_RAIL)) {
    if (lower.includes(key)) return codes;
  }
  return null;
}

function settlementFor(railName) {
  const lower = (railName || '').toLowerCase();
  for (const [key, cfg] of Object.entries(RAIL_SETTLEMENT)) {
    if (lower.includes(key) && cfg.bank_code && cfg.account_number) return cfg;
  }
  return null;
}

/**
 * Compute average daily payout demand for a rail.
 *
 * Two signals are combined and the higher one wins:
 *   A) destination-bank traffic  — payout_items WHERE bank_code IN (on-us codes)
 *      Reflects genuine future on-us demand regardless of how it was routed in
 *      the past. Good signal once smart routing is active.
 *   B) historical rail usage     — rail_disbursements WHERE rail_id = this rail
 *      Captures anything the rail has actually processed: JIT fallbacks, Kuda
 *      re-routing, or any non-on-us traffic that landed here. Must not be
 *      ignored even if routing bias existed before smart routing.
 *
 * avgDailyKobo = MAX(A_avg, B_avg)   (conservative: neither signal is discarded)
 * Returns { avgDailyKobo, totalKoboA, totalKoboB, txnCountA, txnCountB }
 */
async function projectedDemand(bankCodes, railId) {
  // Signal A: destination bank traffic
  let totalKoboA = 0n, txnCountA = 0;
  if (bankCodes && bankCodes.length) {
    const placeholders = bankCodes.map((_, i) => `$${i + 1}`).join(', ');
    const rowsA = await p['$queryRawUnsafe'](`
      SELECT
        COALESCE(SUM(amount), 0) AS total_kobo,
        COUNT(*)                  AS txn_count
      FROM payout_items
      WHERE bank_code IN (${placeholders})
        AND created_at > NOW() - INTERVAL '${HISTORY_DAYS} days'
        AND status != 'failed'
    `, ...bankCodes);
    totalKoboA = BigInt(rowsA[0].total_kobo || 0);
    txnCountA  = Number(rowsA[0].txn_count  || 0);
  }

  // Signal B: historical rail disbursement volume (actual usage of this rail)
  let totalKoboB = 0n, txnCountB = 0;
  if (railId) {
    const rowsB = await p['$queryRawUnsafe'](`
      SELECT
        COALESCE(SUM(amount), 0) AS total_kobo,
        COUNT(*)                  AS txn_count
      FROM rail_disbursements
      WHERE rail_id = $1::uuid
        AND created_at > NOW() - INTERVAL '${HISTORY_DAYS} days'
        AND status != 'failed'
    `, railId);
    totalKoboB = BigInt(rowsB[0].total_kobo || 0);
    txnCountB  = Number(rowsB[0].txn_count  || 0);
  }

  const avgDailyA = totalKoboA / BigInt(HISTORY_DAYS);
  const avgDailyB = totalKoboB / BigInt(HISTORY_DAYS);
  const avgDailyKobo = avgDailyA > avgDailyB ? avgDailyA : avgDailyB;

  return { avgDailyKobo, totalKoboA, totalKoboB, txnCountA, txnCountB,
           signalUsed: avgDailyA >= avgDailyB ? 'destination' : 'rail_history' };
}

/**
 * Top up a rail's float via Parallex NIP if it's below the projected 2-day demand.
 * Returns a result object, or null if no action was needed.
 */
async function topupRail(rail, currentFloatKobo, parallexRailId) {
  const bankCodes = onUsCodesFor(rail.name);
  if (!bankCodes) {
    logger.info({ rail: rail.name }, '[rail-funding] no on-us codes defined for this rail — skipping');
    return null;
  }

  const settle = settlementFor(rail.name);
  if (!settle) {
    logger.info({ rail: rail.name }, '[rail-funding] no settlement account configured — skipping');
    return null;
  }

  const { avgDailyKobo, totalKoboA, totalKoboB, txnCountA, txnCountB, signalUsed } = await projectedDemand(bankCodes, rail.id);

  // Target: 2× avg daily demand × safety buffer, floored at MIN_FLOAT_KOBO
  const projected2Day = BigInt(Math.ceil(Number(avgDailyKobo) * 2 * BUFFER_MULT));
  const target        = projected2Day > MIN_FLOAT_KOBO ? projected2Day : MIN_FLOAT_KOBO;
  const shortfall     = target - currentFloatKobo;

  logger.info({
    rail: rail.name, bankCodes, signalUsed,
    currentFloatNaira:  Number(currentFloatKobo) / 100,
    avgDailyNaira:      Number(avgDailyKobo) / 100,
    targetNaira:        Number(target) / 100,
    shortfallNaira:     Number(shortfall > 0n ? shortfall : 0n) / 100,
    txnCount14d_dest:   txnCountA,
    txnCount14d_rail:   txnCountB,
    vol14dNaira_dest:   Number(totalKoboA) / 100,
    vol14dNaira_rail:   Number(totalKoboB) / 100,
  }, '[rail-funding] float assessment');

  if (shortfall <= 0n) {
    logger.info({ rail: rail.name }, '[rail-funding] float OK — no top-up needed');
    return null;
  }
  if (shortfall < MIN_TOPUP_KOBO) {
    logger.info({ rail: rail.name, shortfallKobo: shortfall.toString() },
      '[rail-funding] shortfall below min threshold — skipping');
    return null;
  }

  // Verify Parallex has enough float
  const plxRows = await p['$queryRawUnsafe'](
    `SELECT float_balance FROM payment_rails WHERE id=$1::uuid`, parallexRailId
  );
  const plxFloat = BigInt(plxRows[0]?.float_balance || 0);
  if (plxFloat < shortfall) {
    logger.warn({ plxFloatNaira: Number(plxFloat)/100, neededNaira: Number(shortfall)/100 },
      '[rail-funding] Parallex float insufficient for top-up');
    return { rail: rail.name, status: 'SKIPPED', reason: `Parallex only has ₦${(Number(plxFloat)/100).toLocaleString()} — need ₦${(Number(shortfall)/100).toLocaleString()}`, shortfallNaira: Number(shortfall)/100 };
  }

  // NE on settlement account
  const orderId = `RF-${(rail.name).replace(/\s+/g, '').slice(0, 10)}-${Date.now()}`.slice(0, 32);
  let ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  if (!ne.ok || !ne.sessionId) {
    await new Promise(r => setTimeout(r, 3000));
    ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  }
  if (!ne.ok || !ne.sessionId) {
    logger.error({ rail: rail.name, settle }, '[rail-funding] NE failed on settlement account');
    return { rail: rail.name, status: 'FAILED', reason: 'NE failed on settlement account', shortfallNaira: Number(shortfall)/100 };
  }

  // Send NIP transfer via Parallex
  let transferResult;
  try {
    transferResult = await parallexTransfer.sendPayout({
      orderId,
      amount:         Number(shortfall),
      bank_code:      settle.bank_code,
      account_number: settle.account_number,
      account_name:   ne.accountName || settle.account_name,
      narration:      `Paylode rail float: ${rail.name}`.slice(0, 50),
      neSessionId:    ne.sessionId,
      neAccountName:  ne.accountName,
      neKycLevel:     ne.kycLevel || '',
    });
  } catch (e) {
    logger.error({ err: e.message, rail: rail.name }, '[rail-funding] Parallex sendPayout threw');
    return { rail: rail.name, status: 'FAILED', reason: e.message, shortfallNaira: Number(shortfall)/100 };
  }

  if (!transferResult.ok) {
    logger.error({ result: transferResult, rail: rail.name }, '[rail-funding] top-up transfer rejected');
    return { rail: rail.name, status: 'FAILED', reason: transferResult.reason || 'transfer rejected', shortfallNaira: Number(shortfall)/100 };
  }

  // Atomically update both rail float balances
  await p['$queryRawUnsafe'](
    `UPDATE payment_rails SET float_balance=float_balance-$1, updated_at=NOW() WHERE id=$2::uuid`,
    shortfall, parallexRailId
  );
  await p['$queryRawUnsafe'](
    `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
    shortfall, rail.id
  );

  logger.info({ rail: rail.name, topupNaira: Number(shortfall)/100, orderId }, '[rail-funding] top-up sent');
  return {
    rail:           rail.name,
    bankCodes,
    status:         'FUNDED',
    topupNaira:     Number(shortfall) / 100,
    targetNaira:    Number(target) / 100,
    floatBeforeNaira: Number(currentFloatKobo) / 100,
    txnCountA14d:   txnCountA,
    txnCountB14d:   txnCountB,
    signalUsed,
    avgDailyNaira:  Number(avgDailyKobo) / 100,
    orderId,
  };
}

async function runFundingCheck() {
  try {
    logger.info('[rail-funding] starting daily float check');

    const parallexRail = await p.paymentRail.findFirst({
      where: { name: { contains: 'parallex', mode: 'insensitive' }, status: 'LIVE' },
      select: { id: true, name: true, floatBalance: true },
    });
    if (!parallexRail) { logger.warn('[rail-funding] Parallex rail not found'); return; }
    if (!parallexTransfer.isConfigured()) { logger.warn('[rail-funding] Parallex transfer not configured'); return; }

    // All other LIVE payout rails (not Parallex)
    const rails = await p.paymentRail.findMany({
      where: { status: 'LIVE', payoutEnabled: true, id: { not: parallexRail.id } },
      select: { id: true, name: true, floatBalance: true },
    });

    if (!rails.length) { logger.info('[rail-funding] no other LIVE rails to check'); return; }

    const results = [];
    for (const rail of rails) {
      const result = await topupRail(rail, BigInt(rail.floatBalance || 0), parallexRail.id);
      if (result) results.push(result);
    }

    const funded  = results.filter(r => r.status === 'FUNDED');
    const failed  = results.filter(r => r.status === 'FAILED');
    const skipped = results.filter(r => r.status === 'SKIPPED');

    logger.info({ funded: funded.length, failed: failed.length, skipped: skipped.length },
      '[rail-funding] daily check complete');

    if (funded.length || failed.length) {
      const rows = results.map(r => `<tr>
        <td>${r.rail}</td>
        <td><strong>${r.status}</strong></td>
        <td>${r.status === 'FUNDED' ? `₦${r.topupNaira.toLocaleString('en-NG', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td>${r.avgDailyNaira != null ? `${r.txnCountA14d||0}d/${r.txnCountB14d||0}r txns · ₦${(r.avgDailyNaira||0).toLocaleString('en-NG', {minimumFractionDigits: 2})}/day (${r.signalUsed||'?'})` : '-'}</td>
        <td style="font-size:11px;color:#666">${r.reason || r.orderId || ''}</td>
      </tr>`).join('');

      await sendEmail({
        to: ALERT_TO,
        subject: `[Paylode Rail Funding] ${funded.length} rail(s) topped up · ${new Date().toLocaleDateString('en-NG')}`,
        html: `<p>Daily rail float check complete.</p>
               <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
               <tr style="background:#f5f5f5"><th>Rail</th><th>Status</th><th>Top-up</th><th>14d Demand</th><th>Note</th></tr>
               ${rows}
               </table>
               <p style="margin-top:10px;font-size:12px;color:#666">Server: 176.57.188.45 · /opt/paylode-api</p>`,
      });
    }
  } catch (e) {
    logger.error({ err: e.message }, '[rail-funding] check error');
  }
}

// Run immediately on startup, then daily at 6am
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function msUntilNext6am() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

runFundingCheck().then(() => {
  const delay = msUntilNext6am();
  logger.info({ nextCheckAt: new Date(Date.now() + delay).toISOString() }, '[rail-funding] next check scheduled');
  setTimeout(function tick() {
    runFundingCheck().finally(() => setTimeout(tick, MS_PER_DAY));
  }, delay);
});

logger.info('[rail-funding] Paylode rail pre-funding cron started');
