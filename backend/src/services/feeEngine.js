'use strict';
/**
 * Paylode Fee Engine
 * All amounts in kobo (BigInt)
 */

const VAT_RATE = 0.075;

function computeFees(amount, merchantRate, merchantCap, railRate, railCap, vatRate = VAT_RATE, aggSplitPct = 0, flatFee = 0) {
  const amt = BigInt(amount);
  const vat = BigInt(Math.round(vatRate * 1_000_000));
  const BASE = 1_000_000n;

  // Merchant fee: (rate × amount + flat_fee), then apply cap
  let merchantFeeRaw = amt * BigInt(Math.round(merchantRate * 1_000_000)) / BASE + BigInt(flatFee);
  const mCap = BigInt(merchantCap || 0);
  if (mCap > 0n && merchantFeeRaw > mCap) merchantFeeRaw = mCap;
  const merchantFeeWithVat = merchantFeeRaw + (merchantFeeRaw * vat / BASE);

  // Rail cost: rate × amount, then apply cap
  let railCostRaw = amt * BigInt(Math.round(railRate * 1_000_000)) / BASE;
  const rCap = BigInt(railCap || 0);
  if (rCap > 0n && railCostRaw > rCap) railCostRaw = rCap;
  const railCostWithVat = railCostRaw + (railCostRaw * vat / BASE);

  const netRevenue = merchantFeeWithVat - railCostWithVat;

  const aggShare = netRevenue > 0n
    ? netRevenue * BigInt(Math.round(aggSplitPct * 1_000_000)) / BASE
    : 0n;

  const paylodeMargin = netRevenue - aggShare;

  return {
    merchantFeeRaw,
    merchantFeeWithVat,
    railCostRaw,
    railCostWithVat,
    netRevenue,
    aggShare,
    paylodeMargin,
    vatOnMerchant: merchantFeeWithVat - merchantFeeRaw,
    vatOnRail:     railCostWithVat - railCostRaw,
  };
}

/**
 * Resolve the effective rate config for a merchant + channel.
 * Priority: per-channel override → ALL override → merchant.processingRate → null (caller uses rail default)
 */
async function getMerchantRateConfig(prisma, merchantId, channel) {
  const [channelOverride, allOverride, merchant] = await Promise.all([
    prisma.merchantRateConfig.findUnique({
      where: { merchantId_channel: { merchantId, channel } },
    }),
    prisma.merchantRateConfig.findUnique({
      where: { merchantId_channel: { merchantId, channel: 'ALL' } },
    }),
    prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { processingRate: true, parentMerchantId: true },
    }),
  ]);

  if (channelOverride) return { rate: Number(channelOverride.rate), flatFee: Number(channelOverride.flatFee), cap: Number(channelOverride.cap) };
  if (allOverride)     return { rate: Number(allOverride.rate),     flatFee: Number(allOverride.flatFee),     cap: Number(allOverride.cap) };

  // Fall back to parent merchant rate config if this is an outlet
  if (merchant?.parentMerchantId) {
    return getMerchantRateConfig(prisma, merchant.parentMerchantId, channel);
  }

  // Fall back to flat processingRate with no cap/flat fee
  if (merchant?.processingRate) return { rate: Number(merchant.processingRate), flatFee: 0, cap: 0 };

  return null;
}

/**
 * Resolve effective aggregator split % for a specific merchant.
 * Priority: per-merchant override → aggregator default split
 */
async function getAggregatorSplit(prisma, aggregatorId, merchantId) {
  if (!aggregatorId) return 0;

  const [override, aggregator] = await Promise.all([
    prisma.aggregatorRateConfig.findUnique({
      where: { aggregatorId_merchantId: { aggregatorId, merchantId } },
    }),
    prisma.aggregator.findUnique({ where: { id: aggregatorId }, select: { revenueSplitPct: true } }),
  ]);

  if (override) return Number(override.splitPct);
  return aggregator ? Number(aggregator.revenueSplitPct) : 0;
}

/**
 * Intelligent rail routing — finds the lowest cost rail for a service type
 */
async function routeTransaction(prisma, serviceType, amount, designatedRailId = null, allowFallback = true) {
  const amt = BigInt(amount);

  if (designatedRailId) {
    const designatedCost = await prisma.$queryRaw`
      SELECT rc.*, pr.name as rail_name, pr.status as rail_status
      FROM rail_costs rc
      JOIN payment_rails pr ON rc.rail_id = pr.id
      WHERE rc.rail_id = ${designatedRailId}::uuid
        AND rc.service_type = ${serviceType}
        AND rc.effective_to IS NULL
        AND pr.status = 'LIVE'
      LIMIT 1
    `;
    if (designatedCost.length > 0) return formatRailResult(designatedCost[0], amt);
    if (!allowFallback) throw new Error(`Designated rail not available for ${serviceType} and fallback is disabled`);
  }

  const rails = await prisma.$queryRaw`
    SELECT rc.*, pr.name as rail_name, pr.id as rail_id
    FROM rail_costs rc
    JOIN payment_rails pr ON rc.rail_id = pr.id
    WHERE rc.service_type = ${serviceType}
      AND rc.effective_to IS NULL
      AND pr.status = 'LIVE'
    ORDER BY rc.rate ASC
  `;

  if (rails.length === 0) throw new Error(`No live rail available for service type: ${serviceType}`);

  let bestRail = null;
  let lowestCost = null;
  for (const rail of rails) {
    const result = formatRailResult(rail, amt);
    if (lowestCost === null || result.effectiveCost < lowestCost) {
      lowestCost = result.effectiveCost;
      bestRail = result;
    }
  }
  return bestRail;
}

function formatRailResult(rail, amount) {
  const rate    = Number(rail.rate);
  const cap     = BigInt(rail.fee_cap || 0);
  const vatRate = Number(rail.vat_rate || 0.075);

  let costRaw = amount * BigInt(Math.round(rate * 1_000_000)) / 1_000_000n;
  if (cap > 0n && costRaw > cap) costRaw = cap;
  const costWithVat = costRaw + (costRaw * BigInt(Math.round(vatRate * 1_000_000)) / 1_000_000n);

  return {
    railId:              rail.rail_id || rail.id,
    railName:            rail.rail_name,
    rate,
    cap:                 Number(cap),
    vatRate,
    effectiveCost:       costWithVat,
    effectiveCostNumber: Number(costWithVat),
    serviceType:         rail.service_type,
    merchantCap:         BigInt(rail.merchant_cap || 0),
  };
}

function channelToServiceType(channel, cardBin = null) {
  const ch = (channel || '').toUpperCase();
  if (ch === 'BANK_TRANSFER') return 'BANK_TRANSFER';
  if (ch === 'USSD')          return 'USSD';
  if (ch === 'DIRECT_DEBIT')  return 'BANK_TRANSFER';
  if (ch === 'PAYOUT')        return 'PAYOUT';
  if (ch === 'CARD' && cardBin) {
    const bin = cardBin.toString().substring(0, 6);
    if (bin.startsWith('4'))                            return 'VISA';
    if (/^5[1-5]/.test(bin) || /^2[2-7]/.test(bin))   return 'MASTERCARD';
    if (/^650[0-4]/.test(bin) || bin.startsWith('506')) return 'VERVE';
    return 'VISA';
  }
  return 'BANK_TRANSFER';
}

// Default rail cost rate used when a live rail rate isn't resolved synchronously.
// Paylode margin (netPool) is provisional on this until reconciled at settlement.
const DEFAULT_RAIL_RATE = Number(process.env.DEFAULT_RAIL_RATE || 0.005);

/**
 * Synchronous per-transaction fee computation — PAYER-FUNDED model (#11, cards/VA).
 * The customer pays (principal + our charge + VAT); the merchant is settled the
 * FULL principal; the rail takes its cut; Paylode keeps (our fee − rail cost);
 * VAT on our fee is collected from the customer and remitted (not revenue).
 *
 * All amounts in kobo (BigInt). checkout.js stores txn.amount = chargeAmount and
 * merchantFee = feePlusVat, so settlement net (gross − fee) == principal.
 *
 * @param amount    principal (kobo)
 * @param merchant  merchant row (uses processingRate as fallback rate)
 * @param rateConfig optional { merchantRate, merchantCap, flatFee, railRate, railCap, aggSplitPct }
 */
function computeFeesForTxn(amount, merchant, rateConfig = null, channel = 'CARD') {
  const BASE = 1_000_000n;
  const principal = BigInt(amount);
  const vat = BigInt(Math.round(VAT_RATE * 1_000_000));
  const cfg = rateConfig || {};
  const merchantRate = cfg.merchantRate != null ? cfg.merchantRate : Number((merchant && merchant.processingRate) || 0.015);
  const railRate     = cfg.railRate     != null ? cfg.railRate     : DEFAULT_RAIL_RATE;
  const flatFee      = BigInt(cfg.flatFee || 0);
  const mCap         = BigInt(cfg.merchantCap || 0);
  const rCap         = BigInt(cfg.railCap || 0);
  const aggSplitPct  = Number(cfg.aggSplitPct || 0);

  // Our charge to the customer (+ VAT)
  let feeRaw = principal * BigInt(Math.round(merchantRate * 1_000_000)) / BASE + flatFee;
  if (mCap > 0n && feeRaw > mCap) feeRaw = mCap;
  const vatOnFee   = feeRaw * vat / BASE;
  const feePlusVat = feeRaw + vatOnFee;

  // Rail cost (+ VAT) — Paylode's cost to move the money
  let railRaw = principal * BigInt(Math.round(railRate * 1_000_000)) / BASE;
  if (rCap > 0n && railRaw > rCap) railRaw = rCap;
  const railPlusVat = railRaw + (railRaw * vat / BASE);

  // Payer-funded amounts
  const chargeAmount       = principal + feePlusVat; // what the customer pays
  const merchantSettlement = principal;              // merchant gets the full principal

  // Paylode revenue = our fee − rail cost (ex-VAT; VAT on our fee is remitted)
  const netPool       = feeRaw - railRaw;
  const aggShare      = netPool > 0n ? netPool * BigInt(Math.round(aggSplitPct * 1_000_000)) / BASE : 0n;
  const paylodeMargin = netPool - aggShare;

  return {
    principal, chargeAmount, merchantSettlement,
    feeRaw, feePlusVat, vatOnFee,
    railRaw, railPlusVat,
    netPool, aggShare, paylodeMargin,
    feePaidBy: 'customer',
  };
}

module.exports = { computeFees, computeFeesForTxn, routeTransaction, channelToServiceType, getMerchantRateConfig, getAggregatorSplit, VAT_RATE, DEFAULT_RAIL_RATE };
