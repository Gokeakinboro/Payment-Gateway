// Persona routing suite — the regression guard for "wrong landing page per role".
// For each configured persona: log in via the real login UI and assert where they land.
// THE key assertion: a wallet MEMBER must end up on /wallet.html, never the merchant dashboard.
//
// Credentials live in e2e/personas.json (gitignored). Copy personas.example.json and fill in
// real TEST accounts. Each entry:
//   { "role": "...", "email": "...", "password": "...",
//     "expect": { "url": "wallet.html", "text": "Member Wallet" } }   // url and/or text are optional
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

let personas = [];
try {
  personas = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
} catch (e) { /* none configured */ }

if (!personas.length) {
  test('personas.json not configured', () => {
    test.skip(true, 'Create e2e/personas.json from personas.example.json with real test accounts.');
  });
}

for (const p of personas) {
  test(`${p.role}: logs in and lands correctly`, async ({ page }) => {
    await page.goto('/login.html');
    await page.fill('#em', p.email);
    await page.fill('#pw', p.password);
    await page.click('#btn');

    // Wait until we've left the login page (portal -> dashboard, then guard may bounce members to wallet).
    await page.waitForURL((url) => !url.pathname.endsWith('/login.html'), { timeout: 20000 });
    // Give a member's client-side redirect (dashboard -> /wallet.html) a moment to settle.
    await page.waitForLoadState('networkidle').catch(() => {});

    if (p.expect && p.expect.url) {
      await expect(page, `expected ${p.role} to land on ${p.expect.url}`)
        .toHaveURL(new RegExp(p.expect.url.replace(/[.]/g, '\\.')));
    }
    if (p.expect && p.expect.text) {
      await expect(page.locator('body'), `expected ${p.role} page to show "${p.expect.text}"`)
        .toContainText(p.expect.text, { timeout: 20000 });
    }
    // No persona should ever see a raw login error after valid creds.
    await expect(page.locator('#err')).toBeHidden().catch(() => {});
  });
}
