# Paylode Failover Runbook — DO Standby

**Primary:** `176.57.188.45` (DB + backend)  
**Standby:** `165.22.21.63` (DO) — PostgreSQL replica streaming live + backend pre-installed (stopped)

---

## When to use this

If `176.57.188.45` is unreachable and cannot be recovered quickly.

---

## Failover — 3 steps (~5 min)

### Step 1 — Promote the standby DB

SSH to DO:
```bash
ssh -i ~/.ssh/id_ed25519 root@165.22.21.63
```

Promote PostgreSQL from replica to primary:
```bash
sudo -u postgres psql -c "SELECT pg_promote();"
```

Expected: `pg_promote` returns `t`. Verify:
```bash
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"
# Should return: f  (no longer in recovery)
```

### Step 2 — Start the backend

```bash
pm2 start /opt/paylode-gateway/ecosystem.config.js
pm2 save
```

Check health:
```bash
curl http://localhost:3000/health
```

### Step 3 — Switch DNS

In your DNS provider (Hostinger / Namecheap / wherever `api.paylodeservices.com` is managed):

Change the **A record** for `api.paylodeservices.com` from `176.57.188.45` → `165.22.21.63`

Set TTL to 60 seconds if possible (for fast propagation).

**Also get the SSL cert on DO** (if not already done):
```bash
certbot --nginx -d api.paylodeservices.com
```

---

## After failover — keep replication going

Once DO is now primary, **do not** restart the old 176 DB without re-configuring it as a new replica. If 176 comes back online, leave its PostgreSQL stopped until 176 is rebuilt as a replica of DO.

---

## Verify replication is healthy (run on primary 176 anytime)

```bash
ssh -i ~/.ssh/id_ed25519 root@176.57.188.45
sudo -u postgres psql -c "SELECT client_addr, state, sent_lsn, replay_lsn FROM pg_stat_replication;"
```

Expected: `state = streaming`, `sent_lsn ≈ replay_lsn` (near-zero lag).

---

## Verify replica is syncing (run on DO anytime)

```bash
ssh -i ~/.ssh/id_ed25519 root@165.22.21.63
sudo -u postgres psql -c "SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();"
```

---

## Update backend code on DO (run after each production deploy)

After deploying a new version to 176:
```bash
ssh -i ~/.ssh/id_ed25519 root@165.22.21.63
cd /opt/paylode-gateway
git pull origin main
cd backend && npm ci --omit=dev
npx prisma generate
```

_(DB schema changes replicate automatically via WAL — no migration needed on DO)_

---

## WireGuard tunnel (176 ↔ DO)

Encrypted private network set up 2026-08-13. Both servers communicate via:

| Server | WireGuard IP | Public IP |
|--------|-------------|-----------|
| 176 (primary) | `10.10.0.1` | `176.57.188.45` |
| DO (standby)  | `10.10.0.2` | `165.22.21.63` |

PostgreSQL replication runs over WireGuard (`client_addr = 10.10.0.2`).  
Parallex proxy traffic: `176 → 10.10.0.2:8443 → DO iptables DNAT → IPSec VPN → 192.18.0.40`.

**If WireGuard goes down:**
```bash
# On 176
systemctl status wg-quick@wg0
systemctl restart wg-quick@wg0

# On DO  
systemctl status wg-quick@wg0
systemctl restart wg-quick@wg0
```

**Check tunnel health:**
```bash
ssh root@165.22.21.63 "ping -c 3 10.10.0.1"
ssh root@176.57.188.45 "wg show wg0"
```
