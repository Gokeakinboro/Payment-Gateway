// Paylode persona suite config. Runs against the LIVE site by default; override with BASE_URL.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 45000,
  expect: { timeout: 15000 },
  fullyParallel: false,        // login flows touch shared sessionStorage assumptions; keep serial
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://paylodeservices.com',
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Members are mobile-first; verify the wallet on a phone viewport too.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /personas\.spec\.js/ },
  ],
});
