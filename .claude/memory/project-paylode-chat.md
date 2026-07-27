---
name: project-paylode-chat
description: "Paylode developer chatbot — Next.js app at /opt/paylode-chat, port 4003, live at paylodeservices.com/developer-chat — ANTHROPIC_API_KEY must be set"
metadata: 
  node_type: memory
  type: project
  originSessionId: 115d40b8-b319-49cd-ac3b-6bed068d546b
---

# Paylode Developer Chat

**URL:** https://paylodeservices.com/developer-chat/
**App dir:** `/opt/paylode-chat/`
**Port:** 4003 (proxied by nginx at `/developer-chat`)
**PM2 name:** `paylode-chat` (id 11)
**DB:** SQLite at `/opt/paylode-chat/prisma/chat.db` (User table: id, email, name, passwordHash)

## Status
- Built 2026-06-11
- Claude-powered (claude-sonnet-4-6), restricted to Paylode topics only
- Off-topic questions directed to sales@paylodeservices.com
- Open registration for any developer

## ✅ FULLY WORKING 2026-06-25 — credit blocker RESOLVED
**Verified responding end-to-end on the live portal.** User added Anthropic credits → the old "credit balance too low" blocker is GONE. Confirmed via external test (no SSH, real user path): register test user `{"ok":true}` + JWT cookie set, then POST `/developer-chat/api/chat` "what is Paylode?" → **HTTP 200 with a real Claude-generated, Paylode-scoped reply.** No server/code change was ever needed — credits were the only blocker.
- **Reusable test account (keep, don't recreate):** `cc-test-1782360324@example.com` / password `Test12345!` (open-registration row in the chat SQLite). Use this for future "is it responding?" checks instead of registering new throwaways.
- **Quick external smoke test:** `curl -c jar -X POST .../developer-chat/api/auth/login -d '{"email":"cc-test-1782360324@example.com","password":"Test12345!"}'` → then `curl -b jar -X POST .../developer-chat/api/chat -d '{"messages":[{"role":"user","content":"ping"}]}'` → expect 200 + a reply (billing error = credits ran out again).

## History — API key set 2026-06-14 (was blocked on NO CREDITS, now resolved above)
`/opt/paylode-chat/.env.local` `ANTHROPIC_API_KEY` was updated to a real key 2026-06-14 (prior placeholder replaced; backup at `.env.local.bak.<ts>`); `pm2 restart paylode-chat --update-env` done, app online (port 4003). At the time the key authenticated but the org had insufficient credits (HTTP 400 invalid_request_error, Plans & Billing) — that is what was fixed 2026-06-25 by adding credits.
To change the key later: edit that file + `cd /opt/paylode-chat && pm2 restart paylode-chat --update-env`.

## Tech stack
- Next.js 16 (App Router) + TypeScript + Tailwind
- Prisma v5 + SQLite for user accounts
- bcryptjs + jsonwebtoken for auth (httpOnly cookie, 7-day sessions)
- @anthropic-ai/sdk for Claude streaming

## Pages
- `/developer-chat/` → redirects to /login or /chat
- `/developer-chat/login` → login page
- `/developer-chat/register` → registration page (open signup)
- `/developer-chat/chat` → the chat UI (requires auth)

## Files
- `lib/prisma.ts` — Prisma client singleton
- `lib/auth.ts` — JWT sign/verify + cookie helpers
- `app/api/auth/register/route.ts` — POST register
- `app/api/auth/login/route.ts` — POST login
- `app/api/auth/logout/route.ts` — POST logout
- `app/api/auth/me/route.ts` — GET current user
- `app/api/chat/route.ts` — POST streaming chat (calls Claude)

## Rebuild after changes
```
cd /opt/paylode-chat && npm run build && pm2 restart paylode-chat
```
