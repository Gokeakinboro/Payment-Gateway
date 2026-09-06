'use strict';
/**
 * Paylode Rail Pre-funding Cron
 *
 * Runs daily at 6am (and immediately on startup).
 * For each LIVE payout rail (except Parallex which is the source):
 *   1. Get current float_balance from DB
 *   2. Compute projected 2-day demand from last 14 days of payout history for that rail
 *   3. Target float = max(avg_daily_demand × 2 × 1.5, MIN_FLOAT_KOBO)
 *   4. If float < target: top up (target - float) via Parallex NIP to that rail's settlement account
 *   5. Update both rail floats in DB; send summary email if any top-ups were done
 *
 * Settlement accounts (Paylode's merchant accounts with each rail provider):
 *   PalmPay : bank_code=100033 account=8882777449 (hardcoded — same as JIT Kuda funding)
 *   OPay    : set OPAY_SETTLE_BANK + OPAY_SETTLE_ACCOUNT in env
 */
require('dotenv').config({ path: '/opt/paylode-api/backend/.env' });
const { PrismaClient } = require('/opt/paylode-api/backend/node_modules/.prisma/client');
const { sendEmail }        = require('/opt/paylode-api/backend/src/services/emailService');
const parallexTransfer     = require('/opt/paylode-api/backend/src/modules/gateway-core/services/parallexTransferService');
const { logger }           = require('/opt/paylode-api/backend/src/utils/logger');

const p = new PrismaClient();
const ALERT_TO = 'gokeakinboro@gmail.com';

// How many days of history to look at for the projection
const HISTORY_DAYS  = 14;
// Minimum float target per rail (₦20,000) — avoid tiny floats on any live rail
const MIN_FLOAT_KOBO = 2_000_000n;
// Safety buffer multiplier on top of 2-day projection
const BUFFER_MULT   = 1.5;
// Minimum top-up amount (don't initiate a transfer < ₦5,000 — not worth the cost)
const MIN_TOPUP_KOBO = 500_000n;

// Settlement accounts: how Paylode tops up each rail's merchant account via Parallex NIP
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

function settlementFor(railName) {
  const lower = (railName || '').toLowerCase();
  for (const [key, cfg] of Object.entries(RAIL_SETTLEMENT)) {
    if (lower.includes(key) && cfg.bank_code && cfg.account_number) return cfg;
  }
  return null;
}

async function getProjectedDemand(railId) {
  // Average daily payout volume dispatched through this rail over last HISTORY_DAYS days.
  // Returns BigInt kobo.
  const rows = await p['$queryRawUnsafe'](`
    SELECT COALESCE(SUM(rd.amount),0) AS total_kobo
    FROM rail_disbursements rd
    WHERE rd.rail_id = $1::uuid
      AND rd.created_at > NOW() - INTERVAL '${HISTORY_DAYS} days'
      AND rd.status NOT IN ('failed','reversed')
  `, railId);
  const totalKobo = BigInt(rows[0].total_kobo || 0);
  const avgDaily  = totalKobo / BigInt(HISTORY_DAYS);
  return avgDaily;
}

async function topupRail(rail, currentFloatKobo, parallexRailId) {
  const settle = settlementFor(rail.name);
  if (!settle) {
    logger.info({ rail: rail.name }, '[rail-funding] no settlement account configured — skipping');
    return null;
  }

  const avgDaily   = await getProjectedDemand(rail.id);
  const target     = BigInt(Math.ceil(Number(avgDaily) * 2 * BUFFER_MULT));
  const safeTarget = target < MIN_FLOAT_KOBO ? MIN_FLOAT_KOBO : target;
  const shortfall  = safeTarget - currentFloatKobo;

  if (shortfall <= 0n) {
    logger.info({ rail: rail.name, float: currentFloatKobo.toString(), target: safeTarget.toString() },
      '[rail-funding] float OK — no top-up needed');
    return null;
  }
  if (shortfall < MIN_TOPUP_KOBO) {
    logger.info({ rail: rail.name, shortfall: shortfall.toString() },
      '[rail-funding] shortfall below min top-up threshold — skipping');
    return null;
  }

  // Check Parallex has enough float
  const plxRows = await p['$queryRawUnsafe'](`SELECT float_balance FROM payment_rails WHERE id=$1::uuid`, parallexRailId);
  const plxFloat = BigInt(plxRows[0]?.float_balance || 0);
  if (plxFloat < shortfall) {
    logger.warn({ plxFloat: plxFloat.toString(), needed: shortfall.toString() },
      '[rail-funding] Parallex float insufficient for top-up');
    return { rail: rail.name, status: 'SKIPPED', reason: 'Parallex float insufficient', shortfall: Number(shortfall) };
  }

  // NE on settlement account
  const orderId = `RF-${rail.name.replace(/\s+/g, '').slice(0, 10)}-${Date.now()}`.slice(0, 32);
  let ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  if (!ne.ok || !ne.sessionId) {
    await new Promise(r => setTimeout(r, 3000));
    ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  }
  if (!ne.ok || !ne.sessionId) {
    logger.error({ rail: rail.name, settle }, '[rail-funding] NE failed on settlement account');
    return { rail: rail.name, status: 'FAILED', reason: 'NE failed', shortfall: Number(shortfall) };
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
      narration:      `Paylode rail top-up: ${rail.name}`.slice(0, 50),
      neSessionId:    ne.sessionId,
      neAccountName:  ne.accountName,
      neKycLevel:     ne.kycLevel || '',
    });
  } catch (e) {
    logger.error({ err: e.message, rail: rail.name }, '[rail-funding] Parallex sendPayout threw');
    return { rail: rail.name, status: 'FAILED', reason: e.message, shortfall: Number(shortfall) };
  }

  if (!transferResult.ok) {
    logger.error({ result: transferResult, rail: rail.name }, '[rail-funding] Parallex top-up transfer failed');
    return { rail: rail.name, status: 'FAILED', reason: transferResult.reason || 'transfer rejected', shortfall: Number(shortfall) };
  }

  // Update both rail floats atomically in DB
  await p['$queryRawUnsafe'](
    `UPDATE payment_rails SET float_balance=float_balance-$1, updated_at=NOW() WHERE id=$2::uuid`,
    shortfall, parallexRailId
  );
  await p['$queryRawUnsafe'](
    `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
    shortfall, rail.id
  );

  logger.info({ rail: rail.name, topupKobo: shortfall.toString(), orderId },
    '[rail-funding] top-up sent successfully');
  return {
    rail:       rail.name,
    status:     'FUNDED',
    topupKobo:  Number(shortfall),
    topupNaira: Number(shortfall) / 100,
    orderId,
    floatBefore: Number(currentFloatKobo),
    target:     Number(safeTarget),
  };
}

async function runFundingCheck() {
  try {
    logger.info('[rail-funding] starting daily float check');

    const parallexRail = await p.paymentRail.findFirst({
      where: { name: { contains: 'parallex', mode: 'insensitive' }, status: 'LIVE' },
      select: { id: true, name: true, floatBalance: true },
    });
    if (!parallexRail) {
      logger.warn('[rail-funding] Parallex rail not found — cannot fund');
      return;
    }
    if (!parallexTransfer.isConfigured()) {
      logger.warn('[rail-funding] Parallex transfer not configured — skipping');
      return;
    }

    // All other LIVE payout rails
    const rails = await p.paymentRail.findMany({
      where: {
        status: 'LIVE',
        payoutEnabled: true,
        id: { not: parallexRail.id },
      },
      select: { id: true, name: true, floatBalance: true },
    });

    if (!rails.length) {
      logger.info('[rail-funding] no other LIVE rails to check');
      return;
    }

    const results = [];
    for (const rail of rails) {
      const currentFloat = BigInt(rail.floatBalance || 0);
      const result = await topupRail(rail, currentFloat, parallexRail.id);
      if (result) results.push(result);
    }

    const funded = results.filter(r => r.status === 'FUNDED');
    const failed = results.filter(r => r.status === 'FAILED');
    const skipped = results.filter(r => r.status === 'SKIPPED');

    logger.info({ funded: funded.length, failed: failed.length, skipped: skipped.length },
      '[rail-funding] daily check complete');

    if (funded.length || failed.length) {
      const rows = results.map(r => `<tr>
        <td>${r.rail}</td>
        <td><strong>${r.status}</strong></td>
        <td>${r.status === 'FUNDED' ? `₦${(r.topupNaira).toLocaleString('en-NG', { minimumFractionDigits: 2 })}` : '-'}</td>
        <td style="font-size:11px;color:#666">${r.reason || r.orderId || ''}</td>
      </tr>`).join('');

      await sendEmail({
        to: ALERT_TO,
        subject: `[Paylode Rail Funding] ${funded.length} rail(s) topped up · ${new Date().toLocaleDateString('en-NG')}`,
        html: `<p>Daily rail float check complete. Summary:</p>
               <table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;font-size:13px">
               <tr style="background:#f5f5f5"><th>Rail</th><th>Status</th><th>Top-up</th><th>Note</th></tr>
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
  const now = new Date();
  const next = new Date(now);
  next.setHours(6, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

runFundingCheck().then(() => {
  const delay = msUntilNext6am();
  logger.info({ nextCheckMs: delay, nextCheck: new Date(Date.now() + delay).toISOString() },
    '[rail-funding] next daily check scheduled');
  setTimeout(function tick() {
    runFundingCheck().finally(() => {
      setTimeout(tick, MS_PER_DAY);
    });
  }, delay);
});

logger.info('[rail-funding] Paylode rail pre-funding cron started');
