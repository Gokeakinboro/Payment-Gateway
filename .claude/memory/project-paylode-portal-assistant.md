---
name: project-paylode-portal-assistant
description: Paylode Portal Assistant — role-aware in-portal help chatbot (how to sign up / use the portal) on the MAIN backend; built+deployed 2026-07-01
metadata: 
  node_type: memory
  type: project
  originSessionId: 610c646d-1fbf-4f5b-bc7b-05e1192617b6
---

# Paylode Portal Assistant (LIVE 2026-07-01)

In-portal help chatbot for **using/navigating the Paylode portal** — distinct from the [[project-paylode-chat]] Developer Chat (that's a separate Next.js app for API/SDK coding help). This one lives on the **main backend (paylode-api, 176)** and reuses the dashboard session.

## Endpoints (mounted `/api/v1/assistant` in server.js)
- `POST /api/v1/assistant/chat` — **requireAuth**, role-aware (reads `req.user.role` → tailors answers). For logged-in merchants + staff.
- `POST /api/v1/assistant/public-chat` — **no auth**, sign-up/onboarding help. For login/onboarding pages.
- Both call Claude (`claude-sonnet-4-6`, override `ASSISTANT_MODEL`) via the Messages API using global `fetch` (Node 20 on box) with the KB as a **cached system prompt** + guardrail (portal topics only; else → product@paylodeservices.com / Developer Chat). Returns `{status,data:{reply}}`.

## Files (repo: Payment-Gateway)
- `backend/src/modules/assistant/index.js` — router (KB read via fs at load).
- `backend/src/modules/assistant/portal-help-kb.md` — **THE KNOWLEDGE BASE** (edit this to change what the bot knows; redeploy the file to 176 + `pm2 reload paylode-api`). Has `⟨CONFIRM⟩` gaps → see [[kiv-portal-assistant-kb-gaps]].
- `assistant-widget.js` — self-contained floating widget; config `window.PAYLODE_ASSISTANT={mode:'authed'|'public'}`. Included on dashboard.html (authed), login.html + onboarding.html (public), all `?v=1`.

## Config / deploy
- Needs `ANTHROPIC_API_KEY` in `/opt/paylode-api/backend/.env` (176) — copied from `/opt/paylode-chat/.env.local` (reuses the dev-chat key, user-authorized 2026-07-01) + `pm2 reload paylode-api --update-env`.
- Backend deploy: scp module files to `/opt/paylode-api/backend/src/modules/assistant/` (mkdir -p first); the `server.js` mount was inserted **in-place** via sed (prod server.js may carry drift — do NOT overwrite it wholesale; KIV #7 in [[kiv-invoice-collect-paymentlinks]]).
- Frontend: scp `assistant-widget.js` + the 3 html to `/var/www/paylode/` on 45 + 176.
- **Verified live 2026-07-01:** public-chat 200 with KB-sourced sign-up answer; guardrail declines off-topic → product@; authed `/chat` 401 without token.

## PRs (open, deployed manually ahead of merge)
- #29 `feat/portal-assistant` (base = #28 branch) — backend + widget + dashboard/onboarding includes.
- login.html widget committed on `feat/single-login` (#26).

## Notes
- Support contact in KB = **product@paylodeservices.com** + **WhatsApp 09073128016 (chat only, NO calls — must be stated)**.
- To broaden knowledge: edit `portal-help-kb.md`, redeploy, reload. Cheap due to prompt caching.
