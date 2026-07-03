'use strict';
/**
 * P2 DB-boundary lint. Enforces the data-ownership manifest (src/modules/_domains.js):
 *   - a PRODUCT module (invoicing/wallet/assistant) may touch only its own prefixed
 *     tables (+ shared-read identity models/tables, read-only) — flag anything else;
 *   - the CORE domain must not raw-query product tables (inv_ or mw_) — the only
 *     core→product path is the sanctioned payinFinalize require-hooks.
 * Catalogued KNOWN_EXCEPTIONS pass but stay visible. New/undeclared crossings fail.
 *
 * Detection is deliberately narrow to avoid prose false-positives: Prisma model
 * access (`prisma.<model>` / `tx.<model>`) and table names inside `$queryRaw*` /
 * `$executeRaw*` bodies only.
 *
 * Run from backend/:  node tools/db-boundary-check.js
 */
const fs = require('fs');
const path = require('path');
const M = require('../src/modules/_domains');

const SRC = path.join(__dirname, '..', 'src');
const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw)/;

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const rel = (f) => path.relative(SRC, f).replace(/\\/g, '/');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

// Prisma model accesses: prisma.<model>.<method> / tx.<model>.<method>
function modelAccesses(src) {
  const re = /\b(?:prisma|tx|trx|client)\.(\$?[a-zA-Z_]\w*)(?:\.([a-zA-Z_]\w*))?/g;
  const out = []; let m;
  while ((m = re.exec(src)) !== null) {
    const model = m[1]; if (model.startsWith('$')) continue; // $transaction/$queryRaw etc.
    out.push({ model, method: m[2] || '', write: WRITE_METHODS.test(m[2] || ''), idx: m.index });
  }
  return out;
}

// SQL keywords that can follow FROM/JOIN/INTO/UPDATE but are NOT table names
// (e.g. `... ON CONFLICT DO UPDATE SET ...`, `INSERT INTO x SELECT ...`).
const SQL_KW = new Set(['set', 'select', 'values', 'where', 'using', 'distinct',
  'returning', 'on', 'as', 'and', 'or', 'not', 'null', 'only']);

// Table names inside raw-SQL bodies only.
function rawTableAccesses(src) {
  const call = /\$(?:query|execute)Raw(?:Unsafe)?\s*(?:`([\s\S]*?)`|\(\s*`([\s\S]*?)`|\(\s*['"]([\s\S]*?)['"])/g;
  const out = []; let c;
  while ((c = call.exec(src)) !== null) {
    const body = c[1] || c[2] || c[3] || '';
    const t = /\b(FROM|JOIN|INTO|UPDATE)\s+"?([a-z_][a-z0-9_]*)"?/gi; let m;
    while ((m = t.exec(body)) !== null) {
      const table = m[2].toLowerCase();
      if (SQL_KW.has(table)) continue;
      out.push({ table, write: /INTO|UPDATE/i.test(m[1]), idx: c.index });
    }
  }
  return out;
}

const isException = (r, access) =>
  M.KNOWN_EXCEPTIONS.some((e) => r === e.where || r.endsWith(e.where) ) &&
  M.KNOWN_EXCEPTIONS.some((e) => (r === e.where || r.endsWith(e.where)) && access.startsWith(e.access));

const violations = [];
const exceptionsHit = new Set();

function noteException(r, access) {
  const e = M.KNOWN_EXCEPTIONS.find((x) => r.endsWith(x.where) && access.startsWith(x.access));
  if (e) { exceptionsHit.add(`${e.where} :: ${e.access}`); return true; }
  return false;
}

// ── Product-domain checks ────────────────────────────────────────────────────
for (const [name, d] of Object.entries(M.DOMAINS)) {
  if (d.kind !== 'product') continue;
  for (const file of walk(path.join(SRC, '..', d.path))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const r = rel(file);

    for (const a of modelAccesses(src)) {
      const access = `prisma.${a.model}${a.method ? '.' + a.method : ''}`;
      const sharedRead = M.SHARED_READ_MODELS.includes(a.model);
      const sharedWrite = M.SHARED_WRITE_MODELS.includes(a.model);
      const isCore = M.CORE_MODELS.includes(a.model);
      if (!isCore) continue;                       // not a core model → product's own concern
      if (sharedWrite) continue;                   // products own their sub-user Users
      if (sharedRead && !a.write) continue;        // allowed read of identity model
      if (noteException(r, access)) continue;      // catalogued
      violations.push({ file: r, line: lineOf(src, a.idx), what: access,
        why: sharedRead ? 'WRITE to shared-read identity model' : `product touches core model '${a.model}'` });
    }

    for (const a of rawTableAccesses(src)) {
      const ownsIt = d.ownsPrefixes.some((p) => a.table.startsWith(p));
      if (ownsIt) continue;
      if (M.SHARED_TABLES.includes(a.table)) continue;
      if (M.SHARED_READ_TABLES.includes(a.table) && !a.write) continue;
      const access = `raw:${a.table}`;
      if (noteException(r, access)) continue;
      violations.push({ file: r, line: lineOf(src, a.idx), what: `${a.write ? 'WRITE' : 'read'} ${a.table}`,
        why: M.SHARED_READ_TABLES.includes(a.table) ? 'WRITE to shared-read identity table'
           : /^(inv_|mw_)/.test(a.table) ? 'cross-product table access'
           : `product touches non-owned table '${a.table}'` });
    }
  }
}

// ── Core must not raw-query product tables ──────────────────────────────────
for (const file of walk(path.join(SRC, 'modules', 'gateway-core'))) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const r = rel(file);
  for (const a of rawTableAccesses(src)) {
    if (/^(inv_|mw_)/.test(a.table)) {
      violations.push({ file: r, line: lineOf(src, a.idx), what: `raw ${a.table}`,
        why: 'core raw-queries a product table (use the payinFinalize hook instead)' });
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Ownership: invoicing=inv_*, wallet=mw_*, core=25 Prisma models. Shared-read: ${M.SHARED_READ_TABLES.join(',')}.`);
console.log(`Catalogued exceptions hit: ${exceptionsHit.size}/${M.KNOWN_EXCEPTIONS.length}`);
for (const e of M.KNOWN_EXCEPTIONS) console.log(`   • ${e.where} — ${e.access}  (${exceptionsHit.has(`${e.where} :: ${e.access}`) ? 'seen' : 'NOT SEEN — stale?'})`);

if (violations.length) {
  console.log(`\n✗ ${violations.length} BOUNDARY VIOLATION(S):`);
  for (const v of violations) console.log(`  ${v.file}:${v.line}  ${v.what}  — ${v.why}`);
  console.log('\nRESULT: DB BOUNDARY BROKEN');
  process.exit(1);
}
console.log('\n✓ no undeclared cross-domain DB access\nRESULT: DB BOUNDARIES OK');
process.exit(0);
