'use strict';
/**
 * One-shot monitor: watches whether the parallex-bank IPsec Phase 2 SA
 * successfully rekeys at the ~1-hour mark after the lifetime fix was applied.
 *
 * Runs 3 checks (pre-rekey, post-rekey, second-cycle) then exits.
 * Start with: pm2 start ... --no-autorestart
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const net = require('net');
const fs  = require('fs');
const { execFile } = require('child_process');
const { sendEmail } = require('../services/emailService');

const ALERT_TO = 'gokeakinboro@paylodeservices.com';
const PARALLEX_IP   = '192.18.0.40';
const PARALLEX_PORT = 443;
const DO_RELAY      = '165.22.21.63';
const FLAG_PATH = process.env.PARALLEX_FAILOVER_FLAG_PATH || '/tmp/parallex_failover.json';

// Checks: [ label, delay_ms_from_start ]
// SA [912] was ~24 min old when fix was applied.
// Phase 2 expires at 60 min → rekey expected in ~36 min from fix.
// Check 1 at 30 min: pre-rekey baseline
// Check 2 at 65 min: should have survived first rekey
// Check 3 at 125 min: survived second rekey cycle (confirms stable)
const CHECKS = [
  { label: 'Pre-rekey (T+30 min)',          delayMs: 30 * 60_000 },
  { label: 'Post-first-rekey (T+65 min)',   delayMs: 65 * 60_000 },
  { label: 'Post-second-rekey (T+125 min)', delayMs: 125 * 60_000 },
];

function checkTcp(ip, port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error',   () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.connect(port, ip);
  });
}

function readFlag() {
  try { return JSON.parse(fs.readFileSync(FLAG_PATH, 'utf8')); }
  catch { return null; }
}

function sshIpsecStatus() {
  return new Promise(resolve => {
    execFile('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=no',
      `root@${DO_RELAY}`,
      'ipsec statusall 2>&1 | grep -E "parallex-bank.*(ESTABLISHED|CONNECTING|rekeying|bytes)"',
    ], { timeout: 15000 }, (err, stdout) => {
      resolve(err ? `(SSH unavailable: ${err.message})` : stdout.trim());
    });
  });
}

async function runCheck(label) {
  const [tunnelUp, flag, ipsecOut] = await Promise.all([
    checkTcp(PARALLEX_IP, PARALLEX_PORT),
    Promise.resolve(readFlag()),
    sshIpsecStatus(),
  ]);

  const status  = tunnelUp ? '✅ UP' : '🔴 DOWN';
  const flagStr = flag ? `${flag.down ? '🔴 FAILOVER ACTIVE' : '✅ normal'} (updated ${flag.updatedAt})` : '(unreadable)';

  const html = `
    <h2>Parallex IPsec Rekey Monitor — ${label}</h2>
    <table style="border-collapse:collapse;font-family:monospace;font-size:13px">
      <tr><td style="padding:4px 16px;font-weight:bold">Check time</td><td>${new Date().toISOString()}</td></tr>
      <tr><td style="padding:4px 16px;font-weight:bold">TCP 192.18.0.40:443</td><td style="font-size:15px">${status}</td></tr>
      <tr><td style="padding:4px 16px;font-weight:bold">Failover flag</td><td>${flagStr}</td></tr>
    </table>
    ${ipsecOut ? `<h3 style="margin-top:16px">ipsec statusall (parallex-bank)</h3><pre style="background:#f5f5f5;padding:10px;font-size:12px">${ipsecOut}</pre>` : ''}
    <p style="color:#888;font-size:11px;margin-top:16px">
      Fix applied: ikelifetime=86400s · lifetime=3600s · margintime=270s · dpddelay=20s · dpdtimeout=90s<br>
      ipsecRekeyCheck.js · 176.57.188.45
    </p>
  `;

  const subject = tunnelUp
    ? `✅ Parallex rekey check PASSED — ${label}`
    : `🔴 Parallex rekey check FAILED — ${label}`;

  await sendEmail({ to: ALERT_TO, subject, html })
    .catch(e => console.error(`[rekeyCheck] email failed: ${e.message}`));

  console.log(`[rekeyCheck] ${label} → TCP ${status}, failover: ${flag?.down ? 'ACTIVE' : 'normal'}`);
  return tunnelUp;
}

async function main() {
  console.log('[rekeyCheck] Starting — will check at T+30, T+65, T+125 min');
  const startMs = Date.now();

  for (const { label, delayMs } of CHECKS) {
    const remaining = delayMs - (Date.now() - startMs);
    if (remaining > 0) {
      console.log(`[rekeyCheck] Sleeping ${Math.round(remaining / 60000)} min until "${label}"`);
      await new Promise(r => setTimeout(r, remaining));
    }
    await runCheck(label);
  }

  console.log('[rekeyCheck] All checks complete — exiting.');
  process.exit(0);
}

main().catch(e => { console.error('[rekeyCheck] Fatal:', e.message); process.exit(1); });
