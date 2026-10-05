'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  treasuryCron.js — Hourly rail float monitor + cross-rail rebalancer
//
//  Every hour:
//    1. Poll balances for all LIVE payment_rails
//    2. Target = 80% of 1-day projected demand for each rail
//    3. LOW rail  (< 50% of target) → fund from Parallex main via payout
//    4. No main funds → cross-rail: drain surplus rail to deficit rail directly
//    5. HIGH rail (> 250% of target) → drain excess back to Parallex TPT account
//    6. Alert via email on LOW / CRITICAL / main-is-low
//
//  Every 12 hours: email report of all cross-rail transfers since last report
//
//  Safety: ALL destinations verified against a HARDCODED whitelist of Paylode
//  TPT/settle accounts. Destinations are never read from user input or arbitrary
//  env vars — only from system-level env vars for known rail accounts.
//  Any transfer to an unknown account is BLOCKED and alerted. No exceptions.
//
//  Env vars:
//    TREASURY_DRAIN_BANK    — bank where merchants fund us (default: 076 Parallex)
//    TREASURY_DRAIN_ACCOUNT — account where merchants fund us (default: PARALLEX_TRANSFER_DEBIT_ACCOUNT)
//    OPAY_SETTLE_BANK / OPAY_SETTLE_ACCOUNT — OPay settle account (when live)
//    TREASURY_MAIN_RAIL     — rail name fragment for hub (default: parallex)
//    TREASURY_ALERT_EMAIL   — alert recipient (default: MPGS_ADMIN_NOTIFY_EMAIL)
//
//  pm2: pm2 start src/cron/treasuryCron.js --name paylode-treasury
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient }         = require('@prisma/client');
const { payoutAdapterForName } = require('../modules/gateway-core/services/payoutRailAdapter');
const parallexTransfer         = require('../modules/gateway-core/services/parallexTransferService');
const { sendEmail }            = require('../services/emailService');
const { logger }               = require('../utils/logger');

const p = new PrismaClient();

// ── Config ────────────────────────────────────────────────────────────────────
const HISTORY_DAYS     = 14;
const BUFFER_DAYS      = 1;      // 1-day demand window
const BUFFER_MULT      = 0.8;    // target float = 80% of 1-day avg demand
const LOW_PCT          = 0.50;   // fund when balance < 50% of target
const CRITICAL_PCT     = 0.20;   // critical alert when < 20% of target
const HIGH_PCT         = 10.0;   // drain when > 1000% of target (conservative — avoids draining active rails)
const DRAIN_COOLDOWN_H = 6;      // hours to wait before retrying a failed drain on same rail
const MIN_FLOAT_KOBO   = BigInt(50_000_000);   // ₦500,000 minimum float on any rail
const MIN_TOPUP_KOBO   = BigInt(500_000);      // ₦5,000 minimum transfer (no noise)
const MIN_MAIN_RESERVE = BigInt(10_000_000);   // ₦100,000 keep in main before funding others

const MAIN_RAIL_FRAGMENT = (process.env.TREASURY_MAIN_RAIL || 'parallex').toLowerCase();
const ALERT_EMAIL        = process.env.TREASURY_ALERT_EMAIL || process.env.MPGS_ADMIN_NOTIFY_EMAIL || 'gokeakinboro@paylodeservices.com';

// ── Drain destination: whichever bank merchants are currently funding into ─────
// Today this is our Parallex TPT account (1000362849).
// When the primary funding bank changes, update TREASURY_DRAIN_BANK/ACCOUNT in .env.
// Defaults to PARALLEX_TRANSFER_DEBIT_ACCOUNT so no separate config is needed initially.
const DRAIN_TO_BANK    = process.env.TREASURY_DRAIN_BANK    || '076';
const DRAIN_TO_ACCOUNT = process.env.TREASURY_DRAIN_ACCOUNT || process.env.PARALLEX_TRANSFER_DEBIT_ACCOUNT || '';

// ── Rail settle accounts (where Parallex NIP funds each rail's float) ─────────
// Only our own Paylode TPT/merchant accounts at each provider.
// Never add an account here that is not registered with that provider as ours.
const RAIL_SETTLEMENT = {
  palmpay: { bank_code: '100033', account_number: '8882777449', account_name: 'Paylode PalmPay Account' },
  opay:    { bank_code: process.env.OPAY_SETTLE_BANK || '', account_number: process.env.OPAY_SETTLE_ACCOUNT || '', account_name: 'Paylode OPay Account' },
};

// ── On-us codes (for demand projection bank code lookup) ──────────────────────
const ON_US_CODES_BY_RAIL = {
  palmpay: new Set(['100033']),
  opay:    new Set(['100004']),
};

// ── Safety whitelist ──────────────────────────────────────────────────────────
// STRICTLY the set of Paylode-owned accounts at each rail provider.
// Built from system env vars only — no user-configurable account numbers.
// Any transfer to an account NOT in this set is BLOCKED before execution.
function buildAllowedAccounts() {
  const set = new Set();
  for (const cfg of Object.values(RAIL_SETTLEMENT)) {
    if (cfg.bank_code && cfg.account_number) set.add(`${cfg.bank_code}:${cfg.account_number}`);
  }
  if (DRAIN_TO_ACCOUNT) set.add(`${DRAIN_TO_BANK}:${DRAIN_TO_ACCOUNT}`);
  return set;
}

function isAllowedDestination(bankCode, accountNumber) {
  return buildAllowedAccounts().has(`${bankCode}:${accountNumber}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function settlementFor(railName) {
  const lower = (railName || '').toLowerCase();
  for (const [key, cfg] of Object.entries(RAIL_SETTLEMENT)) {
    if (lower.includes(key) && cfg.bank_code && cfg.account_number) return cfg;
  }
  return null;
}

function isMainRail(railName) {
  return (railName || '').toLowerCase().includes(MAIN_RAIL_FRAGMENT);
}

function onUsCodesFor(railName) {
  const lower = (railName || '').toLowerCase();
  for (const [key, codes] of Object.entries(ON_US_CODES_BY_RAIL)) {
    if (lower.includes(key)) return codes;
  }
  return null;
}

function naira(kobo) {
  return (Number(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

function ref(prefix) {
  return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// ── DB: treasury_transfers log ────────────────────────────────────────────────
async function ensureTable() {
  await p.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS treasury_transfers (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      from_rail      TEXT        NOT NULL,
      to_rail        TEXT        NOT NULL,
      amount_kobo    BIGINT      NOT NULL,
      bank_code      TEXT,
      account_number TEXT,
      transfer_type  TEXT        NOT NULL,
      provider_ref   TEXT,
      status         TEXT        NOT NULL DEFAULT 'pending',
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await p.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS treasury_transfers_created_at_idx ON treasury_transfers (created_at DESC)`);
}

async function logTransfer({ fromRail, toRail, amountKobo, bankCode, accountNumber, transferType, providerRef, status, notes }) {
  try {
    await p.$executeRawUnsafe(
      `INSERT INTO treasury_transfers (from_rail,to_rail,amount_kobo,bank_code,account_number,transfer_type,provider_ref,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      fromRail, toRail, Number(amountKobo), bankCode || null, accountNumber || null,
      transferType, providerRef || null, status, notes || null,
    );
  } catch (e) {
    logger.error({ err: e.message }, '[treasury] logTransfer failed');
  }
}

// ── Projected demand (signal A: destination traffic; signal B: rail history) ─
async function projectedDemand(bankCodes, railId) {
  if (!bankCodes.length && !railId) return { avgDailyKobo: 0n };

  const now   = new Date();
  const day14 = new Date(now - 14 * 86400000);
  const day7  = new Date(now - 7  * 86400000);
  const TEST_MID = '5ef65b47-2797-4af0-a100-8af5b6a79157';

  let avgDailyA = 0n;
  if (bankCodes.length) {
    const [row] = await p.$queryRawUnsafe(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE created_at >= $3), 0)::bigint AS total_recent,
        COALESCE(SUM(amount) FILTER (WHERE created_at <  $3), 0)::bigint AS total_prior,
        COUNT(*)             FILTER (WHERE created_at >= $3)             AS cnt_recent,
        COUNT(*)             FILTER (WHERE created_at <  $3)             AS cnt_prior
      FROM payout_items
      WHERE bank_code = ANY($1::text[])
        AND status = 'success'
        AND created_at >= $2
        AND merchant_id != $4::uuid
    `, bankCodes, day14, day7, TEST_MID);
    const totalA    = BigInt(row?.total_recent || 0) + BigInt(row?.total_prior || 0);
    const cntRecent = Number(row?.cnt_recent || 0);
    const cntPrior  = Number(row?.cnt_prior  || 0);
    const velocity  = cntPrior > 0 ? Math.min(2.5, Math.max(1.0, cntRecent / cntPrior)) : 1.0;
    const raw       = totalA / BigInt(HISTORY_DAYS);
    avgDailyA = raw * BigInt(Math.round(velocity * 1000)) / 1000n;
  }

  let avgDailyB = 0n;
  if (railId) {
    const [row] = await p.$queryRawUnsafe(`
      SELECT COALESCE(SUM(amount),0)::bigint AS total_b FROM rail_disbursements
      WHERE rail_id = $1::uuid AND created_at >= $2
    `, railId, day14);
    avgDailyB = BigInt(row?.total_b || 0) / BigInt(HISTORY_DAYS);
  }

  const avgDailyKobo = avgDailyA >= avgDailyB ? avgDailyA : avgDailyB;
  return { avgDailyKobo };
}

// ── Get state for all LIVE rails ──────────────────────────────────────────────
async function getRailStates() {
  const rails = await p.$queryRawUnsafe(`SELECT id::text, name FROM payment_rails WHERE status = 'LIVE' ORDER BY name`);
  const states = [];

  for (const rail of rails) {
    const adapter = payoutAdapterForName(rail.name);
    const settle  = settlementFor(rail.name);
    const isMain  = isMainRail(rail.name);

    let balance = null;
    const balSource = isMain ? parallexTransfer : adapter;
    if (balSource && balSource.getBalance) {
      try { balance = await balSource.getBalance(); }
      catch (e) { logger.warn({ rail: rail.name, err: e.message }, '[treasury] getBalance failed'); }
    }

    const onUsCodes = onUsCodesFor(rail.name);
    const bankCodes = onUsCodes ? [...onUsCodes] : (settle ? [settle.bank_code] : []);
    const { avgDailyKobo } = await projectedDemand(bankCodes, rail.id).catch(() => ({ avgDailyKobo: 0n }));

    // Target = BUFFER_MULT × BUFFER_DAYS × avg daily demand
    const rawTarget       = avgDailyKobo * BigInt(BUFFER_DAYS) * BigInt(Math.round(BUFFER_MULT * 1000)) / 1000n;
    const effectiveTarget = rawTarget < MIN_FLOAT_KOBO ? MIN_FLOAT_KOBO : rawTarget;

    states.push({ id: rail.id, name: rail.name, adapter, settle, isMain, balance, effectiveTarget, avgDailyKobo });
  }
  return states;
}

// ── Fund a rail from Parallex main (standard path) ───────────────────────────
async function fundFromMain(state, amountKobo, orderId) {
  const { settle, name } = state;
  if (!settle) return { ok: false, reason: 'no settle account configured' };

  if (!isAllowedDestination(settle.bank_code, settle.account_number)) {
    const msg = `BLOCKED: ${name} settle ${settle.bank_code}:${settle.account_number} not in whitelist`;
    logger.error({ name, settle }, '[treasury] ' + msg);
    await sendAlert('SECURITY', `Fund transfer BLOCKED for ${name} — destination not in whitelist`, { name, settle });
    return { ok: false, reason: msg };
  }

  let ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  if (!ne.ok) ne = await parallexTransfer.nameEnquiry(settle.bank_code, settle.account_number).catch(() => ({ ok: false }));
  if (!ne.ok) {
    await logTransfer({ fromRail: 'parallex', toRail: name, amountKobo, bankCode: settle.bank_code, accountNumber: settle.account_number, transferType: 'fund_rail', status: 'failed', notes: 'NE failed' });
    return { ok: false, reason: 'NE failed on settle account' };
  }

  const result = await parallexTransfer.sendPayout({
    orderId, amount: Number(amountKobo),
    bank_code: settle.bank_code, account_number: settle.account_number,
    account_name: ne.accountName || settle.account_name,
    narration: `Rail top-up: ${name}`, sessionId: ne.sessionId,
  }).catch(e => ({ ok: false, reason: e.message }));

  await logTransfer({
    fromRail: 'parallex', toRail: name, amountKobo,
    bankCode: settle.bank_code, accountNumber: settle.account_number,
    transferType: 'fund_rail', providerRef: result.providerRef,
    status: result.ok ? 'success' : 'failed', notes: result.reason || null,
  });
  logger.info({ rail: name, amountKobo: Number(amountKobo), ok: result.ok, ref: result.providerRef }, '[treasury] fundFromMain');
  return result;
}

// ── Cross-rail: surplus rail directly to deficit rail settle ──────────────────
async function crossRailFund(fromState, toState, amountKobo, orderId) {
  const { settle } = toState;
  if (!settle) return { ok: false, reason: 'no settle account on target rail' };
  if (!fromState.adapter?.sendPayout) return { ok: false, reason: 'source rail has no sendPayout' };

  if (!isAllowedDestination(settle.bank_code, settle.account_number)) {
    const msg = `BLOCKED: cross-rail target ${toState.name} ${settle.bank_code}:${settle.account_number} not in whitelist`;
    logger.error({}, '[treasury] ' + msg);
    await sendAlert('SECURITY', `Cross-rail BLOCKED to ${toState.name} — destination not in whitelist`, {});
    return { ok: false, reason: msg };
  }

  const result = await fromState.adapter.sendPayout({
    orderId, amount: Number(amountKobo),
    bank_code: settle.bank_code, account_number: settle.account_number,
    account_name: settle.account_name, narration: `Cross-rail: ${fromState.name} → ${toState.name}`,
  }).catch(e => ({ ok: false, reason: e.message }));

  await logTransfer({
    fromRail: fromState.name, toRail: toState.name, amountKobo,
    bankCode: settle.bank_code, accountNumber: settle.account_number,
    transferType: 'cross_rail', providerRef: result.providerRef,
    status: result.ok ? 'success' : 'failed', notes: result.reason || null,
  });
  logger.info({ from: fromState.name, to: toState.name, amountKobo: Number(amountKobo), ok: result.ok }, '[treasury] crossRailFund');
  return result;
}

// ── Drain surplus from a rail back to our Parallex TPT account ────────────────
async function recentDrainFailed(railName) {
  const cutoff = new Date(Date.now() - DRAIN_COOLDOWN_H * 3600 * 1000);
  const [row] = await p.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS cnt FROM treasury_transfers
    WHERE from_rail = $1 AND transfer_type = 'drain_rail' AND status = 'failed' AND created_at >= $2
  `, railName, cutoff);
  return (row?.cnt || 0) > 0;
}

async function drainToMain(state, amountKobo, orderId) {
  if (!DRAIN_TO_ACCOUNT) {
    logger.warn({ rail: state.name }, '[treasury] drain skipped: TREASURY_DRAIN_ACCOUNT not set');
    return { ok: false, reason: 'TREASURY_DRAIN_ACCOUNT not configured' };
  }
  if (!state.adapter?.sendPayout) return { ok: false, reason: 'rail has no sendPayout' };

  if (await recentDrainFailed(state.name)) {
    logger.warn({ rail: state.name }, '[treasury] drain skipped: recent failure — waiting cooldown');
    return { ok: false, reason: `drain cooldown: failed within last ${DRAIN_COOLDOWN_H}h` };
  }

  if (!isAllowedDestination(DRAIN_TO_BANK, DRAIN_TO_ACCOUNT)) {
    logger.error({ DRAIN_TO_BANK, DRAIN_TO_ACCOUNT }, '[treasury] BLOCKED: Parallex TPT not in whitelist (check PARALLEX_TRANSFER_DEBIT_ACCOUNT)');
    return { ok: false, reason: 'BLOCKED: drain destination not in whitelist' };
  }

  const result = await state.adapter.sendPayout({
    orderId, amount: Number(amountKobo),
    bank_code: DRAIN_TO_BANK, account_number: DRAIN_TO_ACCOUNT,
    account_name: 'Paylode Parallex TPT Account', narration: `Drain: ${state.name} → Parallex`,
  }).catch(e => ({ ok: false, reason: e.message }));

  await logTransfer({
    fromRail: state.name, toRail: 'parallex', amountKobo,
    bankCode: DRAIN_TO_BANK, accountNumber: DRAIN_TO_ACCOUNT,
    transferType: 'drain_rail', providerRef: result.providerRef,
    status: result.ok ? 'success' : 'failed', notes: result.reason || null,
  });
  logger.info({ rail: state.name, amountKobo: Number(amountKobo), ok: result.ok }, '[treasury] drainToMain');
  return result;
}

// ── Alert helpers ─────────────────────────────────────────────────────────────
async function sendAlert(level, message, data) {
  try {
    await sendEmail({
      to: ALERT_EMAIL,
      subject: `[Paylode Treasury ${level}] ${message}`,
      html: `<p><strong>${level}:</strong> ${message}</p>
             <pre style="font-size:12px;background:#f5f5f5;padding:10px;border-radius:4px">${JSON.stringify(data, null, 2)}</pre>
             <p style="font-size:11px;color:#666">Server: 176.57.188.45 · paylode-treasury · ${new Date().toISOString()}</p>`,
    });
  } catch (e) {
    logger.error({ err: e.message }, '[treasury] sendAlert failed');
  }
}

// ── 12-hour email report ──────────────────────────────────────────────────────
async function sendReport(railStates) {
  try {
    const since = new Date(Date.now() - 12 * 3600 * 1000);
    const rows = await p.$queryRawUnsafe(`
      SELECT from_rail, to_rail, transfer_type, status,
             SUM(amount_kobo)::bigint AS total_kobo, COUNT(*)::int AS count,
             MAX(notes) AS sample_reason
      FROM treasury_transfers WHERE created_at >= $1
      GROUP BY from_rail, to_rail, transfer_type, status
      ORDER BY transfer_type, from_rail, to_rail
    `, since);

    const statusColor = bal => {
      if (bal == null) return '#999';
      return '#28a745';
    };

    const balRows = railStates.map(s => {
      const b = s.balance;
      const t = s.effectiveTarget;
      const pct = b != null && t > 0n ? Math.round(Number(b) / Number(t) * 100) : null;
      const stateLabel = b == null ? 'UNKNOWN' :
        b < t * BigInt(Math.round(CRITICAL_PCT * 100)) / 100n ? 'CRITICAL' :
        b < t * BigInt(Math.round(LOW_PCT * 100))      / 100n ? 'LOW' :
        b > t * BigInt(Math.round(HIGH_PCT * 100))     / 100n ? 'HIGH' : 'OK';
      const stateColor = { CRITICAL: 'red', LOW: 'orange', OK: 'green', HIGH: 'blue', UNKNOWN: '#999' }[stateLabel];
      return `<tr>
        <td>${s.name}${s.isMain ? ' <em>(main)</em>' : ''}</td>
        <td style="text-align:right">₦${b != null ? naira(b) : '—'}</td>
        <td style="text-align:right">₦${naira(t)}</td>
        <td style="text-align:right">${pct != null ? pct + '%' : '—'}</td>
        <td style="color:${stateColor};font-weight:bold">${stateLabel}</td>
      </tr>`;
    }).join('');

    const xferRows = rows.length
      ? rows.map(r => `<tr>
          <td>${r.transfer_type}</td><td>${r.from_rail}</td><td>${r.to_rail}</td>
          <td style="text-align:right">₦${naira(BigInt(r.total_kobo))}</td>
          <td style="text-align:right">${r.count}</td>
          <td style="color:${r.status === 'success' ? 'green' : 'red'}">${r.status}</td>
          <td style="font-size:11px;color:#666">${r.status !== 'success' && r.sample_reason ? r.sample_reason : ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" style="color:#999;text-align:center;padding:12px">No cross-rail transfers in last 12h</td></tr>';

    const ts = new Date().toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    await sendEmail({
      to: ALERT_EMAIL,
      subject: `[Paylode Treasury Report] 12h Summary · ${ts}`,
      html: `<h2 style="font-size:16px;margin-bottom:4px">Paylode Treasury — 12-Hour Report</h2>
             <p style="font-size:12px;color:#666;margin-bottom:16px">${ts} · Target = ${Math.round(BUFFER_MULT * 100)}% of 1-day avg demand</p>
             <h3 style="font-size:13px;margin:0 0 6px">Rail Balances</h3>
             <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;min-width:500px">
               <tr style="background:#f5f5f5"><th>Rail</th><th>Balance</th><th>Target</th><th>%</th><th>Status</th></tr>
               ${balRows}
             </table>
             <h3 style="font-size:13px;margin:16px 0 6px">Transfers (last 12h)</h3>
             <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;min-width:500px">
               <tr style="background:#f5f5f5"><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Count</th><th>Status</th><th>Reason</th></tr>
               ${xferRows}
             </table>
             <p style="margin-top:14px;font-size:11px;color:#666">Server: 176.57.188.45 · paylode-treasury (pm2 24)</p>`,
    });
    logger.info('[treasury] 12h report sent');
  } catch (e) {
    logger.error({ err: e.message }, '[treasury] sendReport failed');
  }
}

// ── Main rebalance tick ───────────────────────────────────────────────────────
let running = false;

async function rebalance() {
  if (running) { logger.warn('[treasury] previous tick still running — skipping'); return []; }
  running = true;
  const tick = new Date().toISOString();
  logger.info({ tick }, '[treasury] rebalance start');

  try {
    const states    = await getRailStates();
    const mainState = states.find(s => s.isMain);
    const mainBal   = mainState?.balance ?? null;

    const alerts   = [];
    const transfers = [];

    for (const state of states) {
      if (state.isMain) continue;
      const { name, balance, effectiveTarget, settle } = state;

      if (!settle) { logger.info({ name }, '[treasury] no settle account — skipping'); continue; }
      if (balance === null) { logger.warn({ name }, '[treasury] balance unknown — skipping'); continue; }

      const lowThresh      = effectiveTarget * BigInt(Math.round(LOW_PCT * 100))      / 100n;
      const criticalThresh = effectiveTarget * BigInt(Math.round(CRITICAL_PCT * 100)) / 100n;
      const highThresh     = effectiveTarget * BigInt(Math.round(HIGH_PCT * 100))     / 100n;

      // Log balance vs thresholds every tick for visibility
      logger.info({
        rail: name,
        balanceNaira:  Math.round(Number(balance) / 100),
        targetNaira:   Math.round(Number(effectiveTarget) / 100),
        lowThreshNaira: Math.round(Number(lowThresh) / 100),
        highThreshNaira: Math.round(Number(highThresh) / 100),
        pct: effectiveTarget > 0n ? Math.round(Number(balance) / Number(effectiveTarget) * 100) + '%' : 'n/a',
      }, '[treasury] balance check');

      // Drain excess (only if well above threshold AND no recent drain failure)
      if (balance > highThresh) {
        const excess = balance - effectiveTarget;
        if (excess >= MIN_TOPUP_KOBO) {
          logger.info({ rail: name, excessNaira: Math.round(Number(excess) / 100) }, '[treasury] draining excess');
          const dr = await drainToMain(state, excess, ref('TRES-DRAIN'));
          transfers.push({ type: 'drain', rail: name, amount: Number(excess), ok: dr.ok, reason: dr.reason });
        }
      }

      // Fund if low
      if (balance < lowThresh) {
        const level = balance < criticalThresh ? 'CRITICAL' : 'LOW';
        alerts.push({ rail: name, level, balance, effectiveTarget });
        logger.info({ rail: name, level, deficitNaira: Math.round(Number(effectiveTarget - balance) / 100) }, '[treasury] rail low — funding');

        const deficit = effectiveTarget - balance;
        const topUp   = deficit < MIN_TOPUP_KOBO ? MIN_TOPUP_KOBO : deficit;
        const orderId = ref('TRES-FUND');

        const mainHasEnough = mainBal !== null && mainBal >= topUp + MIN_MAIN_RESERVE;

        if (mainHasEnough) {
          const fr = await fundFromMain(state, topUp, orderId);
          transfers.push({ type: 'fund_rail', to: name, amount: Number(topUp), ok: fr.ok });
        } else {
          // Find a surplus rail to cross-fund from
          const surplus = states.find(s =>
            !s.isMain && s !== state &&
            s.balance !== null && s.balance > s.effectiveTarget * 2n &&
            s.adapter?.sendPayout
          );
          if (surplus) {
            const avail   = surplus.balance - surplus.effectiveTarget;
            const xferAmt = avail < topUp ? avail : topUp;
            if (xferAmt >= MIN_TOPUP_KOBO) {
              const xr = await crossRailFund(surplus, state, xferAmt, ref('TRES-XR'));
              transfers.push({ type: 'cross_rail', from: surplus.name, to: name, amount: Number(xferAmt), ok: xr.ok });
            }
          } else {
            alerts.push({ rail: name, level: 'NO_FUNDS', balance, effectiveTarget, mainBal });
            logger.error({ name, balance: Number(balance) }, '[treasury] NO FUNDS available — transactions may fail');
          }
          if (mainBal !== null && mainBal < MIN_MAIN_RESERVE) {
            alerts.push({ rail: 'parallex', level: 'MAIN_LOW', balance: mainBal });
          }
        }
      }
    }

    // Email critical alerts immediately
    const critical = alerts.filter(a => ['CRITICAL', 'NO_FUNDS', 'MAIN_LOW'].includes(a.level));
    const low      = alerts.filter(a => a.level === 'LOW');

    if (critical.length) {
      await sendAlert('CRITICAL',
        `${critical.length} rail(s) in critical state — transaction failures possible`,
        { alerts: critical.map(a => ({ ...a, balance: a.balance != null ? Number(a.balance) : null, effectiveTarget: a.effectiveTarget != null ? Number(a.effectiveTarget) : null })) }
      );
    } else if (low.length) {
      await sendAlert('LOW_BALANCE',
        `${low.length} rail(s) were low — auto-funded`,
        { alerts: low.map(a => ({ ...a, balance: Number(a.balance), effectiveTarget: Number(a.effectiveTarget) })), transfers }
      );
    }

    logger.info({ tick, alerts: alerts.length, transfers: transfers.length, critical: critical.length }, '[treasury] rebalance complete');
    return states;
  } catch (e) {
    logger.error({ err: e.message }, '[treasury] rebalance error');
    await sendAlert('ERROR', 'Treasury rebalance tick failed: ' + e.message, {});
    return [];
  } finally {
    running = false;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  await ensureTable();
  logger.info({
    mainRail: MAIN_RAIL_FRAGMENT,
    drainToAccount: DRAIN_TO_ACCOUNT ? '***' + DRAIN_TO_ACCOUNT.slice(-4) : 'NOT SET',
    target: `${Math.round(BUFFER_MULT * 100)}% of ${BUFFER_DAYS}d avg demand`,
    lowAt: `${Math.round(LOW_PCT * 100)}% of target`,
    alertTo: ALERT_EMAIL,
  }, '[treasury] started — hourly check, 12h report');

  let lastStates = await rebalance();

  // Schedule 12h report at next 00:00 or 12:00 boundary
  function msUntilNextReport() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() < 12 ? 12 : 24, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  setTimeout(async function reportTick() {
    await sendReport(lastStates);
    setTimeout(reportTick, 12 * 3600 * 1000);
  }, msUntilNextReport());

  // Hourly rebalance
  setTimeout(async function hourlyTick() {
    lastStates = await rebalance();
    setTimeout(hourlyTick, 3600 * 1000);
  }, 3600 * 1000);
}

main().catch(e => {
  logger.error({ err: e.message }, '[treasury] startup fatal');
  process.exit(1);
});
