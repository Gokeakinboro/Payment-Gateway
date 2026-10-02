'use strict';
/**
 * Rail failover monitor — watches one or more VPN-reachable rails.
 * On confirmed outage: auto-switches single-rail merchants to the best available
 * alternative (highest float, LIVE, payout-enabled). Split-routing merchants
 * are never touched.
 * On confirmed recovery: auto-reverts those merchants back to their original routing.
 *
 * State is persisted in rail_failover_assignments so restarts are safe and
 * the revert is always precise (never touches merchants that were already on PalmPay).
 *
 * No wallet reads, writes, or reversals of any kind.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const net             = require('net');
const fs              = require('fs');
const { PrismaClient } = require('@prisma/client');
const { sendEmail }   = require('../services/emailService');

const prisma = new PrismaClient();

// Cheap cross-process signal other services (parallexTransferService.js) read
// to skip straight to PalmPay instead of waiting out a curl timeout per call.
const FAILOVER_FLAG_PATH = process.env.PARALLEX_FAILOVER_FLAG_PATH || '/tmp/parallex_failover.json';
function writeFailoverFlag(railPattern, down) {
  try {
    fs.writeFileSync(FAILOVER_FLAG_PATH, JSON.stringify({ rail: railPattern, down, updatedAt: new Date().toISOString() }));
  } catch (e) { console.error('[failover] could not write flag file:', e.message); }
}

const POLL_MS      = 5 * 60_000;    // how often to check
const CONFIRM_DOWN = 2;             // consecutive failures before acting
const CONFIRM_UP   = 2;             // consecutive successes before reverting
const ALERT_TO     = 'gokeakinboro@paylodeservices.com';
const ALERT_CC     = 'financeadmin@paylodeservices.com,gokeakinboro@gmail.com';

// Monitor targets — one entry per VPN-connected rail.
// railPattern is matched case-insensitively against payment_rails.name.
// Add new entries here as more VPN rails are integrated; switching logic is generic.
const MONITORS = [
  { ip: '192.18.0.40', railPattern: 'parallex' },
];

// Per-monitor runtime state (in-memory; rail IDs loaded from DB at startup)
const monitorState = {};
MONITORS.forEach(m => {
  monitorState[m.railPattern] = {
    railId:    null,
    fails:     0,
    successes: 0,
    down:      false,
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkTcp(ip, port = 443, timeoutMs = 5000) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, ip);
  });
}

async function loadRailIds() {
  for (const m of MONITORS) {
    const rows = await prisma.$queryRaw`
      SELECT id FROM payment_rails
      WHERE LOWER(name) LIKE ${('%' + m.railPattern + '%').toLowerCase()}
        AND payout_enabled = true
      LIMIT 1`;
    if (rows[0]) monitorState[m.railPattern].railId = rows[0].id;
  }
}

// Best available alternative: LIVE, payout_enabled, not the failed rail, ordered by float.
async function bestAlternativeRail(failedRailId) {
  const rows = await prisma.$queryRaw`
    SELECT id, name, float_balance FROM payment_rails
    WHERE id != ${failedRailId}::uuid
      AND status = 'LIVE'
      AND payout_enabled = true
    ORDER BY float_balance DESC
    LIMIT 1`;
  return rows[0] || null;
}

// ── Failover ──────────────────────────────────────────────────────────────────
// Switches single-rail merchants off failedRailId onto failoverRail.
// Returns count of merchants switched.
async function doFailover(failedRailId, failoverRail) {
  // 1. Merchants with an explicit payout_rail_id = failed rail (no active splits, active only).
  const withOverride = await prisma.$queryRaw`
    SELECT m.id, m.payout_rail_id AS original_payout_rail_id
    FROM merchants m
    WHERE m.payout_rail_id = ${failedRailId}::uuid
      AND m.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM merchant_payout_splits s
        WHERE s.merchant_id = m.id AND s.is_active = true
      )`;

  // 2. Merchants with no explicit override who rely on this being the default rail (no active splits, active only).
  const isDefault = await prisma.$queryRaw`
    SELECT 1 FROM payment_rails WHERE id = ${failedRailId}::uuid AND is_default_payout = true`;
  const onDefault = isDefault.length ? await prisma.$queryRaw`
    SELECT m.id, NULL::uuid AS original_payout_rail_id
    FROM merchants m
    WHERE m.payout_rail_id IS NULL
      AND m.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM merchant_payout_splits s
        WHERE s.merchant_id = m.id AND s.is_active = true
      )` : [];

  const affected = [...withOverride, ...onDefault];
  if (!affected.length) return 0;

  let switched = 0;
  for (const m of affected) {
    // Insert assignment record — skip if one already exists (partial unique index).
    let inserted;
    if (m.original_payout_rail_id) {
      inserted = await prisma.$executeRaw`
        INSERT INTO rail_failover_assignments
          (merchant_id, failed_rail_id, failover_rail_id, original_payout_rail_id, switched_at)
        VALUES
          (${m.id}::uuid, ${failedRailId}::uuid, ${failoverRail.id}::uuid,
           ${m.original_payout_rail_id}::uuid, NOW())
        ON CONFLICT DO NOTHING`;
    } else {
      inserted = await prisma.$executeRaw`
        INSERT INTO rail_failover_assignments
          (merchant_id, failed_rail_id, failover_rail_id, original_payout_rail_id, switched_at)
        VALUES
          (${m.id}::uuid, ${failedRailId}::uuid, ${failoverRail.id}::uuid, NULL, NOW())
        ON CONFLICT DO NOTHING`;
    }
    if (inserted) {
      await prisma.$executeRaw`
        UPDATE merchants SET payout_rail_id = ${failoverRail.id}::uuid, updated_at = NOW()
        WHERE id = ${m.id}::uuid`;
      switched++;
    }
  }
  return switched;
}

// ── Revert ────────────────────────────────────────────────────────────────────
// Reverts all merchants that were auto-switched for failedRailId back to their original routing.
async function doRevert(failedRailId) {
  const assignments = await prisma.$queryRaw`
    SELECT id, merchant_id, original_payout_rail_id
    FROM rail_failover_assignments
    WHERE failed_rail_id = ${failedRailId}::uuid AND reverted_at IS NULL`;

  let reverted = 0;
  for (const a of assignments) {
    if (a.original_payout_rail_id) {
      await prisma.$executeRaw`
        UPDATE merchants SET payout_rail_id = ${a.original_payout_rail_id}::uuid, updated_at = NOW()
        WHERE id = ${a.merchant_id}::uuid`;
    } else {
      // Was using default rail — restore NULL so it falls back to system default again.
      await prisma.$executeRaw`
        UPDATE merchants SET payout_rail_id = NULL, updated_at = NOW()
        WHERE id = ${a.merchant_id}::uuid`;
    }
    await prisma.$executeRaw`
      UPDATE rail_failover_assignments SET reverted_at = NOW() WHERE id = ${a.id}::uuid`;
    reverted++;
  }
  return reverted;
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick() {
  for (const m of MONITORS) {
    const s = monitorState[m.railPattern];
    if (!s.railId) { await loadRailIds(); }
    if (!s.railId) {
      console.log(`[failover] ${m.railPattern}: rail not found in DB — skipping`);
      continue;
    }

    const up = await checkTcp(m.ip, 443).catch(() => false);
    const label = `[failover:${m.railPattern}]`;

    if (!up) {
      s.fails++;
      s.successes = 0;
      console.log(`${label} DOWN ${s.fails}/${CONFIRM_DOWN}`);

      if (s.fails === CONFIRM_DOWN && !s.down) {
        s.down = true;
        writeFailoverFlag(m.railPattern, true);
        const alt = await bestAlternativeRail(s.railId);
        const switched = alt ? await doFailover(s.railId, alt) : 0;

        console.log(`${label} Failover triggered — ${alt ? switched + ' merchants → ' + alt.name : 'no alt rail available'}`);

        await sendEmail({
          to: ALERT_TO,
          cc: ALERT_CC,
          subject: `⚠️ ${m.railPattern} unreachable — auto-failover ${alt ? 'activated' : 'failed (no alt rail)'}`,
          html: `
            <p><strong>${m.railPattern}</strong> VPN IP (${m.ip}) has been unreachable for
            ${CONFIRM_DOWN} consecutive checks.</p>
            ${alt
              ? `<p><strong>${switched} merchant(s)</strong> auto-switched to
                 <strong>${alt.name}</strong>. Split-routing merchants were not touched.</p>
                 <p>Will auto-revert when ${m.railPattern} recovers
                 (${CONFIRM_UP} consecutive successful pings required).</p>`
              : `<p><strong>No alternative rail available</strong> — merchants remain on original
                 routing. Add a LIVE, payout-enabled rail with float to enable auto-failover.</p>`}
            <table style="border-collapse:collapse;font-family:monospace;margin:12px 0">
              <tr><td style="padding:4px 12px"><b>VPN IP</b></td><td>${m.ip}</td></tr>
              <tr><td style="padding:4px 12px"><b>Detected at</b></td><td>${new Date().toISOString()}</td></tr>
            </table>
            <p style="color:#888;font-size:12px">parallex-monitor · 176.57.188.45</p>
          `,
        }).catch(e => console.error(`${label} alert email failed:`, e.message));
      }
    } else {
      s.fails = 0;
      if (s.down) {
        s.successes++;
        console.log(`${label} recovery ${s.successes}/${CONFIRM_UP}`);

        if (s.successes >= CONFIRM_UP) {
          const reverted = await doRevert(s.railId);
          s.down = false;
          s.successes = 0;
          writeFailoverFlag(m.railPattern, false);

          console.log(`${label} Reverted ${reverted} merchant(s) back to ${m.railPattern}`);

          await sendEmail({
            to: ALERT_TO,
            cc: ALERT_CC,
            subject: `✅ ${m.railPattern} restored — ${reverted} merchant(s) reverted`,
            html: `
              <p><strong>${m.railPattern}</strong> VPN IP (${m.ip}) is reachable again
              (${CONFIRM_UP} consecutive successful pings).</p>
              <p><strong>${reverted} merchant(s)</strong> auto-reverted to ${m.railPattern}.</p>
              <table style="border-collapse:collapse;font-family:monospace;margin:12px 0">
                <tr><td style="padding:4px 12px"><b>Restored at</b></td><td>${new Date().toISOString()}</td></tr>
              </table>
              <p style="color:#888;font-size:12px">parallex-monitor · 176.57.188.45</p>
            `,
          }).catch(e => console.error(`${label} recovery email failed:`, e.message));
        }
      } else {
        console.log(`${label} UP`);
      }
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// On restart, check the DB for any live failover assignments — if the watcher
// died mid-outage, treat as still down so recovery logic can revert correctly.
async function boot() {
  await loadRailIds();
  for (const m of MONITORS) {
    const s = monitorState[m.railPattern];
    if (!s.railId) continue;
    const active = await prisma.$queryRaw`
      SELECT COUNT(*) AS n FROM rail_failover_assignments
      WHERE failed_rail_id = ${s.railId}::uuid AND reverted_at IS NULL`;
    if (Number(active[0].n) > 0) {
      s.down = true;
      s.fails = CONFIRM_DOWN; // already triggered
      writeFailoverFlag(m.railPattern, true);
      console.log(`[failover:${m.railPattern}] Resumed: ${active[0].n} merchant(s) still on failover from previous outage`);
    } else {
      writeFailoverFlag(m.railPattern, false);
    }
  }
}

boot()
  .then(() => tick())
  .catch(e => console.error('[failover] boot error:', e.message));

setInterval(() => {
  tick().catch(e => console.error('[failover] tick error:', e.message));
}, POLL_MS);
