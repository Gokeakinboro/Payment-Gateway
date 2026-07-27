---
name: project-server-migration
description: "Server role migration plan — 176.57.188.45 → DB+Processing, 45.141.122.223 → Web. AGREED, not yet executed. Resume when ready to do in one pass."
metadata: 
  node_type: memory
  type: project
  originSessionId: 115d40b8-b319-49cd-ac3b-6bed068d546b
---

# Server Role Migration Plan

**Status: ✅ COMPLETE — finished 2026-06-16 ~daytime. All 8 steps done, all sites verified.**
FINAL: 45=web (biz9ja/paylode static+chat/drinksarena frontend/lssb/etc), 176=DB+processing (postgres all DBs, paylode-api:3000, da-backend:5000, golf-platform:4002, webhook-worker, redis). 176 UFW ACTIVE: 22/80/443 open (SSH+golf+CF), 5432/3000/5000 from 45.141.122.223 only. Moved apps removed from 176 (themarket+paylode-chat pm2 + stale nginx vhosts disabled). 45: old da-backend removed, temp mig_key removed from authorized_keys. Verified: biz9ja 200, admin.biz9ja 307, paylodeservices 200, api.drinksarena /api/v1/products 200, drinksarena 200, golf 200 (local).
⚠ SEPARATE PRE-EXISTING ISSUE (not migration): golfplatform.ng does NOT resolve in DNS (empty) — golf serves fine on 176 via IP/local; user should point golfplatform.ng A record → 176.57.188.45 (it's NOT in the migration CF account).
LEFTOVER (optional, harmless): /opt/themarket + /opt/paylode-chat dirs still on 176 (pm2 removed, just disk; rm anytime). mig_key private file still at 176:/root/.ssh/mig_key (deauthorized on 45).

## Agreed Architecture

| Role | Server | Password |
|---|---|---|
| **DB + Processing server** (NOT internet-facing) | 176.57.188.45 | Olatomide@1234@ |
| **Web server** (internet-facing, all nginx) | 45.141.122.223 | Olatomide@12@ |

## Why this layout
- 176 has 185 GB free disk — ideal for databases long-term
- 176 already has all 3 app DBs on PostgreSQL 16
- 45's disk problem was node_modules (cleaned 2026-06-11) — now has ~200+ GB free
- 45 already faces internet for DrinksArena + LSSB (DNS already there)

## Current State (before migration)

### 176.57.188.45 (currently does everything)
- nginx: paylodeservices.com, biz9ja.com, admin.biz9ja.com
- PM2: paylode-api (6 workers, port 3000), themarket/biz9ja (2 workers, port 4000), paylode-chat (port 4003), paylode-webhook-worker, golf-platform (2 workers, port 4002)
- PostgreSQL 16: paylode_db (user: paylode, pass: PaylodeSecure2025), themarket (user: themarket, pass: TheMarket2026), golf_platform
- Redis: localhost:6379
- Static files: /var/www/paylode/ (paylodeservices.com)
- App dirs: /opt/paylode-api/, /opt/themarket/, /opt/paylode-chat/, /opt/golf-platform/

### 45.141.122.223 (currently DrinksArena + LSSB)
- nginx: drinksarena.net, api.drinksarena.net, LSSB
- PM2: da-backend (port 5000), da-frontend (port 3000), lssb-DB, lssb-api-server, lssb-lasrra-proxy, lssb-static-server
- PostgreSQL 14: drinks_arena (user: dauser, pass: dapass2026)
- MySQL: present (LSSB)
- Redis: localhost:6379
- App dirs: /var/www/drinks-arena/, LSSB dirs

## Key Credentials & Ports (after migration)

| Service | Server | Port | Credentials |
|---|---|---|---|
| PostgreSQL paylode_db | 176 | 5432 | paylode / PaylodeSecure2025 |
| PostgreSQL themarket | 176 | 5432 | themarket / TheMarket2026 |
| PostgreSQL drinks_arena | 176 | 5432 | dauser / dapass2026 |
| Redis | 176 | 6379 | no auth |
| paylode-api | 176 | 3000 | — |
| da-backend | 176 | 5000 | — |
| paylode-webhook-worker | 176 | — | — |
| biz9ja Next.js | 45 | 4000 | — |
| paylode-chat Next.js | 45 | 4003 | — |
| da-frontend Next.js | 45 | 3000 (existing) | — |
| golf-platform | 176 | 4002 | — |

## Notes
- paylode-chat uses SQLite (/opt/paylode-chat/prisma/chat.db) — copy the DB file too when moving
- biz9ja also uses Prisma — run `npx prisma generate` after moving and updating DATABASE_URL
- golf-platform stays on 176 (not customer-facing web, internal tool)
- LSSB stays entirely on 45 (already there, no change)
- After DNS change, old SSL certs on 176 become irrelevant; 45 needs new certs for biz9ja.com/paylodeservices.com
