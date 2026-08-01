---
name: kiv-portal-assistant-kb-gaps
description: ✅ DONE 2026-07-13 — Portal Assistant KB gaps all filled; portal-help-kb.md has no remaining ⟨CONFIRM⟩ items
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

✅ **Portal Assistant KB gaps — FILLED 2026-07-13.** All ⟨CONFIRM⟩ items resolved and folded into `backend/src/modules/assistant/portal-help-kb.md`. Deploy to 176 + pm2 reload paylode-assistant needed.

Facts confirmed by Goke:
1. **Settlement cycle** → T+1 business day to registered bank.
2. **Pricing/fees** → Point merchants to Integration → Merchant Pricing in their dashboard.
3. **KYC approval time** → 1–3 business days (confirmed).
4. **Payment limits** → "Contact support" (tier limits not published in KB).
5. **Refunds/chargebacks** → Contact product@paylodeservices.com; team processes via admin portal.
6. **API keys** → Self-serve in Integration → API Keys (confirmed; test keys immediate, live on KYC approval).
7. **2FA location** → Platform Settings (confirmed from code: renderSettings() in app.js).
8. **Payouts funding model** → Pre-funded Payout Wallet; top up via support.
9. **Support hours** → 24/7 (email + WhatsApp chat 09073128016 — chat only, no calls).
10. **Billspay/Member Wallet** → Full description now in KB: closed-loop member wallet, request access via support.

See [[project-paylode-portal-assistant]] for the build/endpoints. **NEXT ACTION: deploy KB file to 176 + `pm2 reload paylode-assistant`.**
