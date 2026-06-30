#!/usr/bin/env node
'use strict';
/**
 * Paylode Wallet smoke harness — run AFTER every deploy.
 * Catches the two failure modes that bit us in prod:
 *   A) MOUNT/AUTH drift — a route returning 404 (unmounted) or the wrong auth code.
 *   B) MEMBER LOGIN e2e — onboard → /auth/login → /wallet/me → never-negative spend guard.
 *
 * Runs ON the API host (needs Prisma + .env + the API listening locally).
 *   cd /opt/paylode-api/backend && node test/smoke/wallet-smoke.js
 * Optional: SMOKE_BASE=http://127.0.0.1:3000 (default).
 *
 * It seeds a throwaway member (email smoke-mem-*), asserts the live HTTP flow,
 * and ALWAYS tears it down (incl. the audit_log row that login writes — that FK
 * blocks user deletion if you forget it).
 */
try { require('dotenv').config(); } catch (e) {}
const http = require('http');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE = (process.env.SMOKE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function call(path, method, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + '/api/v1' + path);
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ code: res.statusCode, json: j, body: d }); });
    });
    req.on('error', (e) => resolve({ code: 0, body: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

// ── PART A: mount + auth smoke (unauthenticated → must be 401, never 404) ──────
const MOUNT_CHECKS = [
  ['/wallet/config', 401],
  ['/wallet/me', 401],
  ['/wallet/admin/requests', 401],
  ['/invoicing/invoices', 401],
  ['/payment-links', 401],
];
async function partA() {
  for (const [path, expect] of MOUNT_CHECKS) {
    const r = await call(path, 'GET');
    const pass = r.code === expect;
    record(`mount ${path} == ${expect}`, pass, pass ? '' : `got ${r.code} (404 = NOT MOUNTED)`);
  }
}

// ── PART B: member login e2e (seed → login → me → never-negative → teardown) ───
async function partB() {
  const enabled = await prisma.$queryRawUnsafe(
    `SELECT merchant_id::text AS mid FROM mw_config WHERE enabled = true LIMIT 1`);
  if (!enabled.length) { record('member-e2e', false, 'no wallet-enabled merchant to test against (skipped)'); return; }
  const merchantId = enabled[0].mid;
  const ts = Date.now();
  const email = `smoke-mem-${ts}@paylode.local`;
  const pw = 'Smoke1234!';
  let userId = null, memberId = null;
  try {
    const u = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(pw, 12), firstName: 'Smoke', lastName: 'Test',
              role: 'MERCHANT', permissions: [], mustChangePassword: false }, select: { id: true } });
    userId = u.id;
    const m = await prisma.$queryRawUnsafe(
      `INSERT INTO mw_members (merchant_id,user_id,name,email,phone,kyc_tier)
       VALUES ($1::uuid,$2::uuid,$3,$4,null,'low') RETURNING id::text`, merchantId, userId, 'Smoke Test', email);
    memberId = m[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO mw_wallets (merchant_id,member_id,low_balance_threshold) VALUES ($1::uuid,$2::uuid,0)`,
      merchantId, memberId);

    const login = await call('/auth/login', 'POST', { email, password: pw });
    const token = login.json && login.json.data && login.json.data.token;
    record('member /auth/login -> 200 + token', login.code === 200 && !!token, login.code === 200 ? '' : `code ${login.code}`);
    if (!token) return;

    const me = await call('/wallet/me', 'GET', null, token);
    const meOk = me.code === 200 && me.json && me.json.data && me.json.data.wallet;
    record('member /wallet/me -> 200', !!meOk, meOk ? `balance ${me.json.data.wallet.balance}` : `code ${me.code}`);

    const depts = await call('/wallet/me/departments', 'GET', null, token);
    record('member /wallet/me/departments -> 200', depts.code === 200, depts.code === 200 ? '' : `code ${depts.code}`);

    // Never-negative guard: spend on a zero balance MUST be rejected (not 200).
    const dept = depts.json && depts.json.data && depts.json.data[0];
    if (dept) {
      const spend = await call('/wallet/me/spend', 'POST', { department_id: dept.id, amount: 100 }, token);
      record('never-negative: spend on 0 balance rejected', spend.code !== 200 && spend.code !== 201,
        `got ${spend.code} ${spend.json ? spend.json.error_code || '' : ''}`);
    }
  } finally {
    // Teardown — order matters; audit_log FK references the user (login writes one).
    if (userId) {
      await prisma.$executeRawUnsafe(`DELETE FROM mw_wallets WHERE member_id IN (SELECT id FROM mw_members WHERE user_id=$1::uuid)`, userId).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM mw_members WHERE user_id=$1::uuid`, userId).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE actor_id=$1::uuid`, userId).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch((e) => record('teardown user delete', false, e.message));
    }
  }
}

(async () => {
  console.log(`\nPaylode Wallet smoke @ ${BASE}\n${'─'.repeat(48)}`);
  await partA();
  await partB();
  await prisma.$disconnect();
  const failed = results.filter((r) => !r.pass);
  console.log(`${'─'.repeat(48)}\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log('FAILURES:', failed.map((f) => f.name).join('; ')); process.exit(1); }
  console.log('ALL GREEN');
})().catch((e) => { console.error('smoke crashed:', e.message); process.exit(2); });
