'use strict';
/**
 * P1a parity guard. Proves the guarded-registry refactor mounts the SAME modules
 * at the SAME base paths in the SAME order as the pre-refactor server.js, and that
 * every module still resolves (loads) cleanly.
 *
 *   BEFORE = the ordered /api/v1/* route mounts in the committed server.js (git HEAD)
 *   AFTER  = the ordered basePaths in modules/registry.js
 *   LOAD   = require the app; assert moduleHealth has zero 'failed'
 *
 * Run from backend/:  node tools/route-parity.js
 * Exit 0 = parity holds; exit 1 = drift.
 */
const { execSync } = require('child_process');

// Middleware app.use('/api/v1/...') calls that are NOT module mounts — excluded.
const MIDDLEWARE_PATHS = new Set([
  '/api/v1/webhooks/inbound',   // express.raw for signature verify
  '/api/v1/onboarding/submit',  // express.json(50mb) + onboardingLimiter
  '/api/v1/auth/login',         // authLimiter
]);

function beforeFromGit() {
  const src = execSync('git show HEAD:backend/src/server.js', { encoding: 'utf8' });
  const out = [];
  const re = /app\.use\(\s*'(\/api\/v1\/[^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!MIDDLEWARE_PATHS.has(m[1])) out.push(m[1]);
  }
  return out;
}

function afterFromRegistry() {
  const { MODULES } = require('../src/modules/registry');
  return MODULES.map((x) => x.basePath);
}

function diff(a, b) {
  const n = Math.max(a.length, b.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) rows.push({ idx: i, before: a[i] || '—', after: b[i] || '—' });
  }
  return rows;
}

let failed = false;

const before = beforeFromGit();
const after = afterFromRegistry();

console.log(`BEFORE (git HEAD server.js): ${before.length} module mounts`);
console.log(`AFTER  (registry):           ${after.length} module mounts`);

const d = diff(before, after);
if (d.length) {
  failed = true;
  console.log('\n✗ ORDER/CONTENT DRIFT:');
  for (const r of d) console.log(`  [${r.idx}] before=${r.before}  after=${r.after}`);
} else {
  console.log('✓ mount list + order identical');
}

// LOAD check — require the app (start() is guarded) and inspect module health.
try {
  const { moduleHealth } = require('../src/server');
  const failedMods = Object.entries(moduleHealth).filter(([, v]) => v.status === 'failed');
  const okCount = Object.values(moduleHealth).filter((v) => v.status === 'ok').length;
  console.log(`\nLOAD: ${okCount}/${Object.keys(moduleHealth).length} modules loaded ok`);
  if (failedMods.length) {
    failed = true;
    console.log('✗ FAILED TO LOAD:');
    for (const [name, v] of failedMods) console.log(`  ${name}: ${v.error}`);
  } else {
    console.log('✓ every module resolved');
  }
} catch (e) {
  failed = true;
  console.log(`\n✗ app failed to load: ${e.message}`);
}

console.log(failed ? '\nRESULT: DRIFT — investigate before merge' : '\nRESULT: PARITY OK');
process.exit(failed ? 1 : 0);
