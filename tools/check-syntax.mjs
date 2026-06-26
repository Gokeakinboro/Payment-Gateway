#!/usr/bin/env node
// Pre-deploy syntax gate. Validates JS files and the JS embedded in HTML files.
// Catches the class of bug that broke production (over-escaped apostrophes that
// make a whole file fail to parse). Exits non-zero on the first failure.
//
// Usage:
//   node tools/check-syntax.mjs                 # check default deploy set
//   node tools/check-syntax.mjs a.js b.html ... # check specific files
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Default set = the files we actually deploy.
const DEFAULT_FILES = [
  'app.js', 'api-wiring.js', 'onboarding.html', 'dashboard.html',
  'checkout.html', 'login.html', 'index.html',
  'backend/src/routes/onboarding.js', 'backend/src/routes/deferrals.js',
  'backend/src/routes/documents.js', 'backend/src/services/deferralExpiryService.js',
  'backend/src/server.js',
];

const args = process.argv.slice(2);
const files = (args.length ? args : DEFAULT_FILES).filter(existsSync);

let failed = 0;
for (const f of files) {
  try {
    if (f.endsWith('.html')) {
      const html = readFileSync(f, 'utf8');
      const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
      if (!scripts.length) { console.log(`  skip  ${f} (no inline script)`); continue; }
      const tmp = join(tmpdir(), 'paylode-syntax-' + Math.random().toString(36).slice(2) + '.js');
      writeFileSync(tmp, scripts.join('\n;\n'));
      try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
      finally { rmSync(tmp, { force: true }); }
    } else {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    }
    console.log(`  ok    ${f}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${f}`);
    const msg = (e.stderr ? e.stderr.toString() : e.message).split('\n').slice(0, 4).join('\n');
    console.error('        ' + msg.replace(/\n/g, '\n        '));
  }
}

if (failed) { console.error(`\n✗ ${failed} file(s) failed syntax check — deploy aborted.`); process.exit(1); }
console.log(`\n✓ ${files.length} file(s) passed syntax check.`);
