'use strict';
/**
 * vpnChainWatcher — monitors the full 176→DO→Parallex VPN chain every 2 minutes.
 *
 * Checks each hop independently:
 *   1. Ping 10.10.0.2  (DO relay WireGuard IP)  — tests 176↔DO tunnel
 *   2. Ping 192.18.0.40 (Parallex private IP)    — tests full chain
 *   3. HTTPS to tptintegration.parallexbank.com  — tests API reachability
 *
 * On failure: auto-restarts wg0 on 176, retries. If still broken, SSHes to
 * DO relay (165.22.21.63) and restarts wg0 there too.
 * Emails a diagnosis alert on sustained failure after auto-fix attempts.
 *
 * PM2 entry:
 *   { name: 'vpn-chain-watcher', script: 'src/cron/vpnChainWatcher.js',
 *     exec_mode: 'fork', instances: 1, autorestart: true,
 *     env: { NODE_ENV: 'production' } }
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { execSync, exec } = require('child_process');
const https   = require('https');
const { sendEmail } = require('../services/emailService');

const POLL_MS    = 120_000;  // check every 2 min
const DO_RELAY   = '165.22.21.63';
const PARALLEX_IP = '192.18.0.40';
const WG_PEER_IP  = '10.10.0.2';  // DO relay's WireGuard internal IP
const ALERT_TO   = 'gokeakinboro@paylodeservices.com';
const ALERT_CC   = 'financeadmin@paylodeservices.com';

// Track alert state so we don't spam emails
let lastAlertKey = null;

function ping(host, timeout = 5) {
  try {
    execSync(`ping -c 2 -W ${timeout} ${host}`, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function checkHttps() {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'tptintegration.parallexbank.com',
      path: '/ThirdPartyTransferAPI/api/ThirdPartyTransfer/Login',
      method: 'POST',
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      resolve({ up: true, code: res.statusCode });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(); resolve({ up: false, reason: 'timeout' }); });
    req.on('error',   () => resolve({ up: false, reason: 'connection error' }));
    req.write('{}');
    req.end();
  });
}

function restartWg176() {
  try {
    execSync('systemctl restart wg-quick@wg0', { timeout: 15000 });
    console.log('[vpn-chain] Restarted wg0 on 176');
    return true;
  } catch (e) {
    console.error('[vpn-chain] Failed to restart wg0 on 176:', e.message);
    return false;
  }
}

function restartWgDO() {
  return new Promise(resolve => {
    exec(
      `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@${DO_RELAY} "systemctl restart wg-quick@wg0"`,
      { timeout: 20000 },
      (err) => {
        if (err) {
          console.error('[vpn-chain] Failed to restart wg0 on DO relay:', err.message);
          resolve(false);
        } else {
          console.log('[vpn-chain] Restarted wg0 on DO relay');
          resolve(true);
        }
      }
    );
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function alert(subject, html, key) {
  if (lastAlertKey === key) return; // suppress duplicate
  lastAlertKey = key;
  await sendEmail({ to: ALERT_TO, cc: ALERT_CC, subject, html }).catch(e =>
    console.error('[vpn-chain] Email failed:', e.message)
  );
}

function clearAlert() { lastAlertKey = null; }

async function tick() {
  // Step 1: check 176↔DO tunnel
  const tunnelUp = ping(WG_PEER_IP);
  // Step 2: check full chain to Parallex
  const chainUp  = ping(PARALLEX_IP);
  // Step 3: HTTPS API check
  const https_   = await checkHttps();

  if (tunnelUp && chainUp && https_.up) {
    clearAlert();
    console.log('[vpn-chain] All hops OK — 176↔DO↔Parallex healthy');
    return;
  }

  // Diagnose
  let diagnosis;
  if (!tunnelUp) {
    diagnosis = '176↔DO tunnel broken (cannot ping 10.10.0.2)';
  } else if (!chainUp) {
    diagnosis = 'DO↔Parallex broken (tunnel OK but cannot ping 192.18.0.40)';
  } else {
    diagnosis = 'Parallex HTTPS unreachable (pings OK but API times out)';
  }

  console.log(`[vpn-chain] FAILURE — ${diagnosis}`);

  // Auto-fix attempt 1: restart wg0 on 176
  console.log('[vpn-chain] Auto-fix: restarting wg0 on 176...');
  restartWg176();
  await sleep(8000);

  const tunnelUp2 = ping(WG_PEER_IP);
  const chainUp2  = ping(PARALLEX_IP);
  const https2    = await checkHttps();

  if (tunnelUp2 && chainUp2 && https2.up) {
    console.log('[vpn-chain] Recovered after wg0 restart on 176');
    await alert(
      '✅ VPN chain restored — wg0 restart on 176 fixed it',
      `<p>The 176→DO→Parallex VPN chain was broken (<b>${diagnosis}</b>).</p>
       <p>Auto-fix: restarted wg0 on 176. Chain is now healthy.</p>
       <p style="color:#888;font-size:12px">vpnChainWatcher · 176.57.188.45 · ${new Date().toISOString()}</p>`,
      'recovered-176'
    );
    clearAlert();
    return;
  }

  // Auto-fix attempt 2: restart wg0 on DO relay
  console.log('[vpn-chain] Still broken — restarting wg0 on DO relay...');
  await restartWgDO();
  await sleep(8000);

  const tunnelUp3 = ping(WG_PEER_IP);
  const chainUp3  = ping(PARALLEX_IP);
  const https3    = await checkHttps();

  if (tunnelUp3 && chainUp3 && https3.up) {
    console.log('[vpn-chain] Recovered after wg0 restart on DO relay');
    await alert(
      '✅ VPN chain restored — wg0 restart on DO relay fixed it',
      `<p>The 176→DO→Parallex VPN chain was broken (<b>${diagnosis}</b>).</p>
       <p>Auto-fix: restarted wg0 on DO relay (165.22.21.63). Chain is now healthy.</p>
       <p style="color:#888;font-size:12px">vpnChainWatcher · 176.57.188.45 · ${new Date().toISOString()}</p>`,
      'recovered-do'
    );
    clearAlert();
    return;
  }

  // Still broken — alert and wait for next tick
  const diagFinal = !tunnelUp3
    ? '176↔DO tunnel still broken after both restarts'
    : !chainUp3
    ? 'DO↔Parallex routing broken after both restarts'
    : 'Parallex HTTPS still unreachable — server may be down';

  console.error(`[vpn-chain] Auto-fix failed — ${diagFinal}`);
  await alert(
    `🚨 VPN chain broken — auto-fix failed (${diagFinal})`,
    `<p><strong>The 176→DO→Parallex VPN chain is broken and auto-fix attempts have failed.</strong></p>
     <table style="border-collapse:collapse;font-family:monospace;margin:12px 0">
       <tr><td style="padding:4px 12px"><b>Initial failure</b></td><td>${diagnosis}</td></tr>
       <tr><td style="padding:4px 12px"><b>After wg0 restart (176)</b></td><td>${tunnelUp2 ? '✅' : '❌'} tunnel | ${chainUp2 ? '✅' : '❌'} chain | ${https2.up ? '✅' : '❌'} HTTPS</td></tr>
       <tr><td style="padding:4px 12px"><b>After wg0 restart (DO)</b></td><td>${tunnelUp3 ? '✅' : '❌'} tunnel | ${chainUp3 ? '✅' : '❌'} chain | ${https3.up ? '✅' : '❌'} HTTPS</td></tr>
       <tr><td style="padding:4px 12px"><b>Detected at</b></td><td>${new Date().toISOString()}</td></tr>
     </table>
     <p>Manual intervention required. Check WireGuard config on both servers and verify Parallex private IP routing.</p>
     <p style="color:#888;font-size:12px">vpnChainWatcher · 176.57.188.45</p>`,
    'sustained-failure'
  );
}

// Run immediately on start, then every 2 min
tick().catch(e => console.error('[vpn-chain] tick error:', e.message));
setInterval(() => {
  tick().catch(e => console.error('[vpn-chain] tick error:', e.message));
}, POLL_MS);
