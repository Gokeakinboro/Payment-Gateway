/**
 * Paylode smoke test — no credentials required.
 * Verifies the live site is up, key pages load, the API backend is healthy,
 * and guarded endpoints return 401 (not 500) when unauthenticated.
 *
 * Run: cd e2e && npm test
 */
const { test, expect, request } = require('@playwright/test');

const API_BASE = process.env.API_BASE || 'https://paylodeservices.com';

// ── 1. Public pages ──────────────────────────────────────────────────────────

test('login page loads with email + password fields', async ({ page }) => {
  await page.goto('/login.html');
  await expect(page).toHaveTitle(/Paylode|Login/i);
  await expect(page.locator('#em, input[type=email]').first()).toBeVisible();
  await expect(page.locator('#pw, input[type=password]').first()).toBeVisible();
  await expect(page.locator('#btn, button[type=submit]').first()).toBeVisible();
});

test('no unhandled JS errors on login page', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/login.html');
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('ResizeObserver') &&
    !e.includes('Non-Error promise rejection')
  )).toHaveLength(0);
});

// ── 2. Static assets ─────────────────────────────────────────────────────────

test('app.js loads with 200', async ({ page }) => {
  const res = await page.request.get('/app.js');
  expect(res.status()).toBe(200);
});

test('api-wiring.js loads with 200', async ({ page }) => {
  const res = await page.request.get('/api-wiring.js');
  expect(res.status()).toBe(200);
});

// ── 3. Backend API reachability ───────────────────────────────────────────────
// /health is not publicly proxied through Cloudflare; verify the API is alive
// via the login endpoint (always responds, never 5xx for bad creds).

test('API is reachable — /api/v1/auth/login responds (not 5xx)', async () => {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post('/api/v1/auth/login', {
    data: { email: 'probe@smoke.test', password: 'x' },
  });
  expect(res.status()).not.toBeGreaterThanOrEqual(500);
  await ctx.dispose();
});

// ── 4. Auth guard — 401, not 500 ──────────────────────────────────────────────
// These endpoints require a token. Without one they should say 401 Unauthorized,
// NOT 500 — a 500 means something crashed server-side.

const GUARDED = [
  '/api/v1/staff/prospects',
  '/api/v1/staff/prospects?stage=lead',
  '/api/v1/wallet/me',
  '/api/v1/transactions',
  '/api/v1/settlements',
];

for (const path of GUARDED) {
  test(`GET ${path} → 401 not 500`, async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.get(path);
    expect(res.status()).not.toBe(500);
    expect([401, 403]).toContain(res.status());
    await ctx.dispose();
  });
}

// ── 5. Prospect creation — 401 not 500 (unauthenticated) ─────────────────────

test('POST /api/v1/staff/prospects returns 401 without auth (not 500)', async () => {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post('/api/v1/staff/prospects', {
    data: { business_name: 'Smoke Test Co' },
  });
  expect(res.status()).not.toBe(500);
  expect([401, 403]).toContain(res.status());
  await ctx.dispose();
});

// ── 6. Login API — bad creds give 401 not 500 ────────────────────────────────

test('POST /api/v1/auth/login with bad creds returns 400 or 401', async () => {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post('/api/v1/auth/login', {
    data: { email: 'nobody@nowhere.invalid', password: 'wrong' },
  });
  expect(res.status()).not.toBe(500);
  expect([400, 401, 422]).toContain(res.status());
  await ctx.dispose();
});
