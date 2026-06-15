#!/usr/bin/env node
'use strict';
/**
 * Post-deploy runtime smoke test — catches the class of failure a code review
 * cannot: prod DB/permission/migration issues that only surface at runtime
 * against the real database (e.g. a table owned by `postgres` so the app role
 * gets 42501 permission-denied — the 2026-06-15 compliance_exceptions incident).
 *
 * Run ON THE SERVER (needs DATABASE_URL, JWT_SECRET, and the API on localhost):
 *   cd /opt/paylode-api/backend && node /opt/paylode-api/scripts/smoke-endpoints.js
 *
 * Two layers:
 *   A. DB ownership — every public table MUST be owned by the app role (paylode).
 *   B. Per-role endpoint probe — log in as each role (by minting a JWT for an
 *      existing user) and GET each page's primary endpoints. ANY 5xx fails.
 *      401/403/404 are acceptable (role scoping / empty resources), not bugs.
 *
 * Exit code 0 = all good; 1 = at least one failure.
 */
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE   = process.env.SMOKE_BASE || 'http://localhost:3000/api/v1';
const APPUSER = process.env.SMOKE_DB_ROLE || 'paylode';
const SECRET = process.env.JWT_SECRET;

// Endpoints to probe per role. GET-only (no mutations). A 5xx on any of these
// is a real bug; 401/403/404 are fine (scoping / no data).
const COMMON_STAFF = [
  '/merchants?perPage=50',
  '/aggregators',
  '/transactions?perPage=20',
  '/kyc/queue?status=submitted&perPage=20',
  '/reports/aml-flags?riskLevel=HIGH',
  '/compliance/exceptions',
  '/compliance/matrix',
  '/settlements',
  '/payouts/wallet',
  '/rails',
];
const ROLE_ENDPOINTS = {
  SUPER_ADMIN:       COMMON_STAFF.concat(['/users', '/reports/revenue', '/reports/cbn-monthly']),
  ADMIN:             COMMON_STAFF.concat(['/users']),
  COMPLIANCE_OFFICER: COMMON_STAFF,
  MERCHANT:          ['/merchants/me', '/transactions?perPage=20', '/payouts/wallet', '/merchants/me/api-keys'],
  AGGREGATOR:        ['/aggregators', '/transactions?perPage=20'],
};

let failures = 0;
const log  = (...a) => console.log(...a);
const fail = (m) => { failures++; console.log('  ✗ FAIL ' + m); };

async function checkOwnership() {
  log('\n[A] DB table ownership (every public table must be owned by ' + APPUSER + ')');
  const rows = await prisma.$queryRawUnsafe(
    "SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' AND tableowner <> $1 ORDER BY tablename",
    APPUSER
  );
  if (!rows.length) { log('  ✓ all tables owned by ' + APPUSER); return; }
  rows.forEach(r => fail('table ' + r.tablename + ' owned by ' + r.tableowner + ' (run: ALTER TABLE ' + r.tablename + ' OWNER TO ' + APPUSER + ';)'));
}

async function tokenFor(role) {
  const user = await prisma.user.findFirst({ where: { role, isActive: true } });
  if (!user) return null;
  return jwt.sign({ userId: user.id }, SECRET, { expiresIn: '5m' });
}

async function probe(role) {
  const token = await tokenFor(role);
  log('\n[B] ' + role + (token ? '' : ' — no active user, skipped'));
  if (!token) return;
  for (const ep of ROLE_ENDPOINTS[role]) {
    let status, ok = true, note = '';
    try {
      const res = await fetch(BASE + ep, { headers: { Authorization: 'Bearer ' + token } });
      status = res.status;
      if (status >= 500) { ok = false; note = (await res.text()).slice(0, 120); }
    } catch (e) { ok = false; status = 'ERR'; note = e.message; }
    if (ok) log('  ✓ ' + status + '  ' + ep);
    else    fail(status + '  ' + ep + '  ' + note);
  }
}

(async () => {
  if (!SECRET) { console.error('JWT_SECRET not set (load backend .env first)'); process.exit(2); }
  log('Smoke test against ' + BASE);
  try {
    await checkOwnership();
    for (const role of Object.keys(ROLE_ENDPOINTS)) await probe(role);
  } catch (e) {
    console.error('Smoke runner error:', e.message); process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
  log('\n' + (failures ? '✗ ' + failures + ' failure(s)' : '✓ all checks passed'));
  process.exit(failures ? 1 : 0);
})();
