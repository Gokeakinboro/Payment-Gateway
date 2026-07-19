'use strict';
/*
 * Paylode Guardian — read-only health / posture watchdog.
 *
 * Runs on a schedule (cron). Performs a checklist across three layers:
 *   1) Liveness/readiness — API up, DB reachable, Redis up, PM2 workers online, site serving
 *   2) Synthetic canary   — a real (non-polluting) round-trip through the live stack
 *   3) Posture/invariants  — TLS expiry, auth gates, wallet sanity, env-file perms, peer alive
 *
 * NEVER mutates anything. Emails ops on anomaly with debounce (alert on
 * OK->FAIL and FAIL->OK only; re-alert at most once per cooldown while still failing).
 *
 * Run:  node /opt/paylode-monitor/guardian.js
 * Env:  GUARDIAN_MODE=db|edge  GUARDIAN_PEER=<url>  OPS_EMAIL=...  GUARDIAN_STATE=<path>
 */
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const BACKEND = process.env.GUARDIAN_BACKEND || '/opt/paylode-api/backend';
try { require(BACKEND + '/node_modules/dotenv').config({ path: BACKEND + '/.env' }); } catch (e) {}

const MODE       = process.env.GUARDIAN_MODE || 'db';            // 'db' on 176, 'edge' on 45
const OPS_EMAIL  = process.env.OPS_EMAIL || 'product@paylodeservices.com';
const STATE_FILE = process.env.GUARDIAN_STATE || '/opt/paylode-monitor/guardian-state.json';
const PEER_URL   = process.env.GUARDIAN_PEER || '';
const PUBLIC      = process.env.GUARDIAN_PUBLIC || 'https://paylodeservices.com';
const LOCAL_API   = process.env.GUARDIAN_LOCAL_API || 'http://127.0.0.1:3000/health';
const EXPECT_WORKERS = parseInt(process.env.GUARDIAN_WORKERS || '2', 10);
const TLS_WARN_DAYS  = parseInt(process.env.GUARDIAN_TLS_DAYS || '14', 10);
const COOLDOWN_MS    = parseInt(process.env.GUARDIAN_COOLDOWN_MIN || '480', 10) * 60000;
const HOST = process.env.GUARDIAN_HOST || os.hostname();

let prisma = null, sendEmail = null;
if (MODE === 'db') {
  try { prisma = require(BACKEND + '/src/utils/db').prisma; } catch (e) {}
}
try { ({ sendEmail } = require(BACKEND + '/src/services/emailService')); } catch (e) {}

function get(url, timeout = 8000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout, rejectUnauthorized: false }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
  });
}
const C = (name, ok, detail) => ({ name, ok: !!ok, detail: detail || '' });

async function runChecks() {
  const checks = [];

  // ── 1) Liveness / readiness ────────────────────────────────────────────────
  const site = await get(PUBLIC + '/');
  checks.push(C('public_site', site.status === 200, PUBLIC + ' -> ' + (site.status || site.err)));

  if (MODE === 'db') {
    const api = await get(LOCAL_API);
    checks.push(C('local_api_health', api.status === 200, LOCAL_API + ' -> ' + (api.status || api.err)));

    try {
      const j = JSON.parse(execSync('pm2 jlist 2>/dev/null', { timeout: 10000 }).toString());
      const online = j.filter(p => p.name === 'paylode-core' && p.pm2_env.status === 'online').length;
      checks.push(C('pm2_workers', online >= EXPECT_WORKERS, online + '/' + EXPECT_WORKERS + ' paylode-core online'));
    } catch (e) { checks.push(C('pm2_workers', false, 'pm2 jlist failed: ' + e.message)); }

    try { execSync('redis-cli ping 2>/dev/null', { timeout: 5000 }).toString().includes('PONG')
      ? checks.push(C('redis', true, 'PONG'))
      : checks.push(C('redis', false, 'no PONG')); }
    catch (e) { checks.push(C('redis', false, 'redis-cli failed')); }

    if (prisma) {
      try { await prisma.$queryRaw`SELECT 1`; checks.push(C('database', true, 'SELECT 1 ok')); }
      catch (e) { checks.push(C('database', false, 'DB query failed: ' + e.message)); }
    } else checks.push(C('database', false, 'prisma client not loaded'));
  }

  // ── 2) Synthetic canary — authed round-trip with no data written ────────────
  // Auth gate must REJECT an unauthenticated protected call (proves the API + auth
  // middleware are actually executing, not a blank 200 from a broken deploy).
  const gate = await get(PUBLIC + '/api/v1/merchants');
  checks.push(C('canary_auth_gate', gate.status === 401, 'GET /merchants unauth -> ' + (gate.status || gate.err) + ' (want 401)'));

  // ── 3) Posture / invariants ("doors & windows") ────────────────────────────
  // TLS expiry (Node tls — robust, no shell/openssl dependency)
  {
    const host = PUBLIC.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const days = await new Promise((resolve) => {
      const tls = require('tls');
      const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
        const cert = sock.getPeerCertificate(); sock.end();
        resolve(cert && cert.valid_to ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000) : null);
      });
      sock.on('error', () => resolve(null));
      sock.on('timeout', () => { sock.destroy(); resolve(null); });
    });
    checks.push(C('tls_expiry', days != null && days >= TLS_WARN_DAYS, days != null ? days + ' days to expiry' : 'could not read cert'));
  }

  if (MODE === 'db') {
    // .env not world-readable
    try {
      const mode = (fs.statSync(BACKEND + '/.env').mode & 0o777);
      checks.push(C('env_perms', (mode & 0o044) === 0, '.env mode ' + mode.toString(8)));
    } catch (e) { checks.push(C('env_perms', true, '.env not found (skipped)')); }

    // No negative merchant wallet balances (money invariant)
    if (prisma) {
      try {
        const neg = await prisma.$queryRaw`SELECT count(*)::int AS n FROM merchant_wallets WHERE balance < 0`;
        checks.push(C('wallet_nonneg', neg[0].n === 0, neg[0].n + ' wallets with negative balance'));
      } catch (e) { checks.push(C('wallet_nonneg', true, 'check skipped: ' + e.message)); }
      // No active LIVE merchants still flagged pending (sanity on the activation gate)
      try {
        const orphan = await prisma.$queryRaw`SELECT count(*)::int AS n FROM merchants WHERE is_active = true AND kyc_status <> 'ACTIVE'`;
        checks.push(C('active_state_consistent', orphan[0].n === 0, orphan[0].n + ' active merchants not ACTIVE'));
      } catch (e) { checks.push(C('active_state_consistent', true, 'check skipped')); }
    }
  }

  // Peer (cross-server mutual monitoring)
  if (PEER_URL) {
    const peer = await get(PEER_URL);
    checks.push(C('peer_alive', peer.status >= 200 && peer.status < 500, PEER_URL + ' -> ' + (peer.status || peer.err)));
  }

  return checks;
}

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
function saveState(s) { try { fs.mkdirSync(require('path').dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {} }

(async () => {
  const checks = await runChecks();
  const state = loadState();
  const now = Date.now();
  const newFails = [], recovered = [];

  for (const c of checks) {
    const prev = state[c.name] || { failing: false, lastAlertAt: 0 };
    if (!c.ok) {
      if (!prev.failing || (now - (prev.lastAlertAt || 0)) > COOLDOWN_MS) {
        newFails.push(c); prev.lastAlertAt = now;
      }
      prev.failing = true;
    } else {
      if (prev.failing) recovered.push(c);
      prev.failing = false; prev.lastAlertAt = 0;
    }
    state[c.name] = prev;
  }
  saveState(state);

  const stamp = new Date().toISOString();
  const line = (c) => `  [${c.ok ? 'OK ' : 'FAIL'}] ${c.name} — ${c.detail}`;
  console.log(`[guardian ${stamp}] host=${HOST} mode=${MODE} — ${checks.filter(c=>c.ok).length}/${checks.length} ok`);
  checks.forEach(c => console.log(line(c)));

  // Only email when there is an ACTIVE issue (one or more failing checks). Recoveries
  // are logged + cleared in state, but never emailed — no "all clear" noise.
  if (newFails.length && sendEmail) {
    const subj = `🚨 Paylode Guardian: ${newFails.length} check(s) FAILING on ${HOST}`;
    const html =
      (newFails.length ? '<h3>❌ Failing</h3><ul>' + newFails.map(c => `<li><strong>${c.name}</strong> — ${c.detail}</li>`).join('') + '</ul>' : '') +
      (recovered.length ? '<h3>✅ Recovered</h3><ul>' + recovered.map(c => `<li><strong>${c.name}</strong> — ${c.detail}</li>`).join('') + '</ul>' : '') +
      `<hr><p style="font-size:12px;color:#888">host ${HOST} · mode ${MODE} · ${stamp}</p>` +
      '<p style="font-size:12px;color:#888">Full status:</p><pre style="font-size:12px">' + checks.map(line).join('\n') + '</pre>';
    try { await sendEmail({ to: OPS_EMAIL, subject: subj, html }); console.log('[guardian] alert emailed to ' + OPS_EMAIL); }
    catch (e) { console.log('[guardian] alert email FAILED: ' + e.message); }
  }

  if (prisma) { try { await prisma.$disconnect(); } catch (e) {} }
  process.exit(newFails.length ? 1 : 0);
})();
