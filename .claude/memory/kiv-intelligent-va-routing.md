---
name: kiv-intelligent-va-routing
description: "🟡 KIV — Intelligent VA pay-in failover routing (auto-switch when primary rail is down)"
metadata:
  type: project
---

**KIV — Intelligent VA routing with automatic failover for pay-in (collections only).**

## What
When Paylode secures a second bank VA connection (beyond PalmPay + Parallex), implement intelligent routing for virtual account pay-in:
- Always use a configured **default VA rail** (e.g. Parallex → new bank → PalmPay in priority order)
- If the default rail is **unavailable** (VPN down, API error, timeout), **automatically switch** to the next available rail
- Scope: **transfers in / pay-in / collections only** — NOT payouts (payout routing is separate SA-configured)

## Why
Parallex VA requires a VPN tunnel that drops intermittently (FortiGate side). When it's down, merchants using Parallex as their pay-in rail can't receive VA collections. A failover to another rail (e.g. PalmPay or new bank) would keep collections live.

## Design sketch
- `payment_rails` already has `status` + `is_default_payout`; add a `payin_priority` integer column (1 = highest priority, null = not in VA pool)
- At checkout VA creation: try rail 1 → if `isConfigured()` returns false or call throws, try rail 2, etc.
- Health state: check rail health (ping `/Login` or a lightweight status call) before selecting; cache result for ~60s
- Per-merchant override (`merchants.payin_rail_id`) still respected — failover only kicks in when that rail is unhealthy
- Audit log which rail was actually used for each VA creation

## Trigger
New bank connection being negotiated (Goke to update this KIV with bank name + timeline when secured).

**How to apply:** When the new bank VA is live and configured, resume here and design the failover layer.
