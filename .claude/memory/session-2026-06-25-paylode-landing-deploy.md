---
name: session-2026-06-25-paylode-landing-deploy
description: Session 2026-06-25 — Paylode landing-page rewrite (product-led + login modal) shipped live; FIXED frontend auto-deploy so a push reaches users (45); dev chatbot verified working. All pushed to origin/main.
metadata: 
  node_type: memory
  type: project
  originSessionId: e6d1ca01-cdbd-4216-980b-3b6cc1164a76
---

Session 2026-06-25 (Paylode). Three things shipped, all live + pushed. See [[project-paylode-dev-deploy]] for the canonical deploy detail and [[project-paylode-chat]] for the chatbot.

## 1. Landing page rewrite — LIVE (commits 1eb336c, 94c22d5)
`index.html` rebuilt from a portal-login page into a **product-led marketing page** (user wanted it to sell Collections + Payouts + benefits):
- Hero: "Collections and Payouts — all from one platform" + "Paylode gives businesses everything they need to collect money: via cards, virtual accounts and transfers, and payouts to any bank — through a single API and dashboard."
- **Products** section: Collections (cards / virtual accounts / bank transfers) + Payouts (instant / bulk / smart routing).
- **Why Paylode** 9-card benefits grid (transparent pricing, easy onboarding, plug-and-play integration, one API/dashboard, fast settlements, secure/compliant, real-time visibility, support, scales).
- 3-step Get Started + CTA band + footer.
- **4 portal login cards REPLACED by a single "Log In" icon (top-right) → modal**: step 1 pick account type, step 2 credentials. Ports login.html's FULL flow (login, 2FA `/api/v1/auth/2fa/validate`, forgot-password, show/hide PW). **"Create Account"** button (label kept per user) opens a **Merchant/Aggregator chooser dropdown**.
- Same navy(#0f1829)/green(#7dc534)/DM-Sans/glass design system.
- Repo: `Gokeakinboro/Payment-Gateway`, cloned fresh to `C:\Users\Goke\Desktop\Payment-Gateway` (no local checkout existed before).

## 2. FIXED frontend auto-deploy (commits 9cbd993, 3870d8b) — THE key infra fix
**Problem found:** the GH Action only deployed frontend to **176** (`SERVER_HOST`), but Cloudflare serves users from **45** → frontend pushes NEVER reached users; had to manually scp to 45. (Diagnosed by probing each origin directly with `--resolve`: 176 had new page, 45 had old, CF served old from 45.)
**Fix:** rewrote `.github/workflows/deploy.yml` to deploy to BOTH — **45 (live)** via `appleboy/scp-action` from the runner (45 has NO git checkout, only static `/var/www/paylode`) + nginx reload; **176 (fallback)** via the original on-box git checkout, `if: always()`. Added secret `WEB_HOST=45.141.122.223`.
**Key gotcha:** the Action's `SERVER_SSH_KEY` only authorized 176 (45 scp failed: "ssh handshake unable to authenticate"). With user authorization, generated a dedicated ed25519 key **`github-actions-deploy-paylode`** (SHA256:a7lFH4caTnlQZrPo6BcbqVJz5n/02Dd+5WpVe13qGSY), appended pubkey to root@45 + root@176 authorized_keys, set its private key as `SERVER_SSH_KEY`, shredded the local copy. **Verified: a plain push to main now goes all-green and updates the live site automatically.** Manual `deploy.py --frontend` to 45 is now only a fallback. Updated `docs/DEPLOYMENT.md`.

## 3. Dev chatbot verified WORKING (no code change)
paylodeservices.com/developer-chat now replies (credit blocker resolved by user adding Anthropic credits). Live-tested register→chat→real Claude reply. Reusable test acct saved: `cc-test-1782360324@example.com` / `Test12345!`. See [[project-paylode-chat]].

## Housekeeping
- Cleaned up the two `index.html.bak-*` backups left on 45 during manual deploys → web root clean.
- Local repo `Desktop\Payment-Gateway` is on `main`, all work pushed to origin (last = 3870d8b). Safe to delete the local clone if desired (repo of record = origin/main).

## OPEN / NEXT (Paylode frontend)
- None blocking. Possible polish: the big in-page CTAs ("Create your account →") still link straight to merchant signup — could also offer the Merchant/Aggregator choice if wanted.
- Cache-bust (`?v=NN`) still needed for app.js/api-wiring.js changes (not index.html).
