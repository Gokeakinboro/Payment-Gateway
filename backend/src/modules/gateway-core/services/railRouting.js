'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Rail routing matrix — the SINGLE way cards / VA / payout pick a rail.
//  Two tiers, per CHANNEL ('CARDS' | 'VA' | 'PAYOUT'):
//    1. per-merchant override  → merchant_rail_routes(merchant, channel)
//    2. SA global default      → rail_channel_defaults(channel)
//
//  POLICY (Goke, 2026-07-08): there is NO cheapest-rail fallback. Routing is a
//  traffic-TYPE decision, not just cost — sending the wrong traffic to a rail can
//  get us disconnected — so SA MUST set the default per channel. resolveRail
//  returns null when nothing is configured; the caller then REJECTS rather than
//  silently guessing a rail.
//
//  Rail eligibility: a per-merchant OVERRIDE may point at a LIVE or CONFIG_ONLY
//  rail (this is how a single sandbox test merchant is routed to a new rail while
//  it's not yet live). The GLOBAL default must be LIVE (it serves everyone).
//
//  The SA setters WRITE THROUGH to the legacy columns they replace
//  (payment_rails.is_default_payout, merchants.payin_rail_id/payout_rail_id,
//  platform_rate_configs.default_rail_id) so older readers/UI stay consistent
//  during the transition while the matrix is the authoritative source.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma: defaultPrisma } = require('../../../utils/db');

const CHANNELS = ['CARDS', 'VA', 'PAYOUT'];
const clientErr = (msg, code) => Object.assign(new Error(msg), { _client: true, _code: code });
function normChannel(channel) {
  const ch = String(channel || '').toUpperCase();
  if (!CHANNELS.includes(ch)) throw clientErr(`Unknown routing channel "${channel}" (expected CARDS | VA | PAYOUT).`, 'BAD_CHANNEL');
  return ch;
}

// ── Resolution ────────────────────────────────────────────────────────────────
// resolveRail(channel, merchant?) → { id, name, status, payout_enabled } | null.
// `prisma` optional first arg keeps parity with the other resolvers in this repo
// that thread a tx/client; falls back to the shared client.
async function resolveRail(prisma, channel, merchant = null) {
  // support resolveRail(channel, merchant) too
  if (typeof prisma === 'string') { merchant = channel || null; channel = prisma; prisma = defaultPrisma; }
  const db = prisma || defaultPrisma;
  const ch = normChannel(channel);
  const merchantId = merchant && (merchant.id || merchant.merchantId);

  if (merchantId) {
    const ov = await db.$queryRaw`
      SELECT pr.id, pr.name, pr.status::text AS status, pr.payout_enabled
      FROM merchant_rail_routes mrr JOIN payment_rails pr ON pr.id = mrr.rail_id
      WHERE mrr.merchant_id = ${merchantId}::uuid AND mrr.channel = ${ch}
        AND pr.status IN ('LIVE', 'CONFIG_ONLY')
      LIMIT 1`;
    if (ov[0]) return ov[0];
    // override rail retired/missing → fall through to the SA default (never guess)
  }
  const def = await db.$queryRaw`
    SELECT pr.id, pr.name, pr.status::text AS status, pr.payout_enabled
    FROM rail_channel_defaults rcd JOIN payment_rails pr ON pr.id = rcd.rail_id
    WHERE rcd.channel = ${ch} AND pr.status = 'LIVE'
    LIMIT 1`;
  return def[0] || null;
}

// ── Read the matrix (SA view) ─────────────────────────────────────────────────
async function getMatrix(prisma = defaultPrisma) {
  const rows = await prisma.$queryRaw`
    SELECT rcd.channel, rcd.rail_id::text AS rail_id, pr.name AS rail_name,
           pr.status::text AS status, pr.payout_enabled, rcd.updated_at
    FROM rail_channel_defaults rcd JOIN payment_rails pr ON pr.id = rcd.rail_id`;
  return CHANNELS.map((channel) => {
    const d = rows.find((r) => r.channel === channel);
    return {
      channel,
      rail_id:   d ? d.rail_id   : null,
      rail_name: d ? d.rail_name : null,
      status:    d ? d.status    : null,
      configured: !!d,
      updated_at: d ? d.updated_at : null,
    };
  });
}

async function requireRail(prisma, railId) {
  const r = await prisma.$queryRaw`
    SELECT id, name, status::text AS status, payout_enabled FROM payment_rails WHERE id = ${railId}::uuid`;
  if (!r[0]) throw clientErr('Unknown rail.', 'UNKNOWN_RAIL');
  return r[0];
}

// ── Set the SA default for a channel (write-through to legacy holders) ─────────
async function setChannelDefault(prisma, channel, railId, updatedBy = null) {
  const ch = normChannel(channel);
  const rail = await requireRail(prisma, railId);
  if (rail.status !== 'LIVE') throw clientErr(`${rail.name} is not LIVE — a channel default must be a live rail.`, 'RAIL_NOT_LIVE');
  if (ch === 'PAYOUT' && !rail.payout_enabled) throw clientErr(`${rail.name} is not payout-enabled.`, 'RAIL_NOT_PAYOUT');

  await prisma.$executeRaw`
    INSERT INTO rail_channel_defaults (channel, rail_id, updated_by, updated_at)
    VALUES (${ch}, ${railId}::uuid, ${updatedBy}::uuid, NOW())
    ON CONFLICT (channel) DO UPDATE
      SET rail_id = EXCLUDED.rail_id, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;

  // Write-through so legacy readers stay in sync.
  if (ch === 'PAYOUT') {
    await prisma.$executeRaw`UPDATE payment_rails SET is_default_payout = (id = ${railId}::uuid), updated_at = NOW()`;
  } else if (ch === 'CARDS') {
    await prisma.$executeRaw`UPDATE platform_rate_configs SET default_rail_id = ${railId}::uuid WHERE channel = 'CARD_LOCAL'`;
  }
  return { channel: ch, rail_id: railId, rail_name: rail.name };
}

// ── Set / clear a per-merchant per-channel override (write-through) ────────────
// railId null/empty → REMOVE the override (merchant reverts to the channel default).
async function setMerchantRoute(prisma, merchantId, channel, railId, updatedBy = null) {
  const ch = normChannel(channel);
  if (!railId) {
    await prisma.$executeRaw`DELETE FROM merchant_rail_routes WHERE merchant_id = ${merchantId}::uuid AND channel = ${ch}`;
    if (ch === 'VA')     await prisma.$executeRaw`UPDATE merchants SET payin_rail_id  = NULL WHERE id = ${merchantId}::uuid`;
    if (ch === 'PAYOUT') await prisma.$executeRaw`UPDATE merchants SET payout_rail_id = NULL WHERE id = ${merchantId}::uuid`;
    return { channel: ch, rail_id: null, removed: true };
  }
  const rail = await requireRail(prisma, railId);
  if (!['LIVE', 'CONFIG_ONLY'].includes(rail.status)) throw clientErr(`${rail.name} cannot carry traffic (status ${rail.status}).`, 'RAIL_UNUSABLE');
  if (ch === 'PAYOUT' && !rail.payout_enabled) throw clientErr(`${rail.name} is not payout-enabled.`, 'RAIL_NOT_PAYOUT');

  await prisma.$executeRaw`
    INSERT INTO merchant_rail_routes (merchant_id, channel, rail_id, updated_by, updated_at)
    VALUES (${merchantId}::uuid, ${ch}, ${railId}::uuid, ${updatedBy}::uuid, NOW())
    ON CONFLICT (merchant_id, channel) DO UPDATE
      SET rail_id = EXCLUDED.rail_id, updated_by = EXCLUDED.updated_by, updated_at = NOW()`;

  if (ch === 'VA')     await prisma.$executeRaw`UPDATE merchants SET payin_rail_id  = ${railId}::uuid WHERE id = ${merchantId}::uuid`;
  if (ch === 'PAYOUT') await prisma.$executeRaw`UPDATE merchants SET payout_rail_id = ${railId}::uuid WHERE id = ${merchantId}::uuid`;
  return { channel: ch, rail_id: railId, rail_name: rail.name };
}

// A merchant's effective route per channel = its override if any, else the default.
async function getMerchantRoutes(prisma, merchantId) {
  const [overrides, defaults] = await Promise.all([
    prisma.$queryRaw`
      SELECT mrr.channel, mrr.rail_id::text AS rail_id, pr.name AS rail_name, pr.status::text AS status
      FROM merchant_rail_routes mrr JOIN payment_rails pr ON pr.id = mrr.rail_id
      WHERE mrr.merchant_id = ${merchantId}::uuid`,
    getMatrix(prisma),
  ]);
  return CHANNELS.map((channel) => {
    const ov = overrides.find((o) => o.channel === channel);
    const def = defaults.find((d) => d.channel === channel);
    const eff = ov || def;
    return {
      channel,
      override_rail_id:   ov ? ov.rail_id   : null,
      override_rail_name: ov ? ov.rail_name : null,
      default_rail_id:    def ? def.rail_id   : null,
      default_rail_name:  def ? def.rail_name : null,
      effective_rail_id:   eff ? eff.rail_id   : null,
      effective_rail_name: eff ? eff.rail_name : null,
      source: ov ? 'override' : (def ? 'default' : 'unset'),
    };
  });
}

module.exports = {
  CHANNELS, resolveRail, getMatrix, getMerchantRoutes, setChannelDefault, setMerchantRoute,
};
