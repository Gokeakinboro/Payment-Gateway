'use strict';
/**
 * Whole-tree relative-require resolver. Statically parses every `require('./x')`
 * / `require('../x')` in src/ and asserts the target resolves on disk. Catches the
 * classic breakage from moving files (a missed import path) WITHOUT executing code.
 *
 * (Same technique used in the 2026-07-03 prod reconciliation to prove all 326
 * relative requires resolve.)
 *
 * Run from backend/:  node tools/resolve-requires.js
 * Exit 0 = all resolve; exit 1 = unresolved requires listed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const exts = ['', '.js', '.json', '/index.js'];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return exts.some((ext) => {
    try { return fs.statSync(base + ext).isFile(); } catch { return false; }
  });
}

// Strip comments so require()s inside docstrings/`/* ... */` aren't false-flagged.
// Line-comment strip uses [^:] before // to avoid eating URLs like http://host.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = walk(ROOT);
const re = /require\(\s*'(\.[^']+)'\s*\)|require\(\s*"(\.[^"]+)"\s*\)/g;
let total = 0;
const broken = [];

for (const f of files) {
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2];
    total++;
    if (!resolves(f, spec)) {
      broken.push({ file: path.relative(ROOT, f), spec });
    }
  }
}

console.log(`Scanned ${files.length} files, ${total} relative requires.`);
if (broken.length) {
  console.log(`\n✗ ${broken.length} UNRESOLVED:`);
  for (const b of broken) console.log(`  ${b.file}  →  ${b.spec}`);
  console.log('\nRESULT: BROKEN REQUIRES');
  process.exit(1);
}
console.log('✓ every relative require resolves\nRESULT: OK');
process.exit(0);
