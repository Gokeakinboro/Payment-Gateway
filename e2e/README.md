# Paylode persona suite (Playwright)

Logs in as each role through the real UI and asserts the **correct landing page** — the
regression guard for "wrong landing per persona" (e.g. a wallet member landing on the
merchant dashboard instead of the wallet app).

## One-time setup
```bash
cd e2e
npm install
npm run install:browsers     # downloads chromium
cp personas.example.json personas.json   # then fill in real TEST accounts
```
`personas.json` is gitignored — it holds credentials, never commit it.

## Run
```bash
# against live (default https://paylodeservices.com)
npm test

# against another environment
BASE_URL=https://staging.example.com npm test

# watch it in a browser
npm run test:headed
```

## What it asserts
For each persona in `personas.json`, after logging in:
- the landing **URL** matches (e.g. member → `wallet.html`, merchant/SA → `dashboard.html`)
- the landing page shows the expected **text** (role label / a nav item)
- no login error is shown after valid credentials

The **member → `wallet.html`** case is the one that would have caught the 2026-06-30 bug
where members were dropped on the merchant dashboard.

## Seeding a member test account
A member is any user in `mw_members`. Onboard one via the merchant wallet dashboard
(Members → Onboard), then complete the first-time password change once so the account has a
stable password, and put those credentials in `personas.json`.

## Companion: API smoke
For backend mount/auth + member-login checks (run on the API host), see
`backend/test/smoke/wallet-smoke.js`.
