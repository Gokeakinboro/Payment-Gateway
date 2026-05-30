'use strict';
/**
 * Paylode Fee Engine
 * Handles all fee calculations with caps and VAT
 * All amounts in kobo (BigInt)
 */

const VAT_RATE = 0.075; // 7.5% VAT

/**
 * Compute fees for a transaction with cap and VAT
 *
 * @param {BigInt} amount           Transaction amount in kobo
 * @param {number} merchantRate     e.g. 0.0150 for 1.5%
 * @param {BigInt} merchantCap      Max merchant fee in kobo (0 = no cap)
 * @param {number} railRate         e.g. 0.0150 for 1.5%
 * @param {BigInt} railCap          Max rail fee in kobo (0 = no cap)
 * @param {number} vatRate          e.g. 0.075 for 7.5% (default)
 * @param {number} aggSplitPct      e.g. 0.30 for 30%
 */
function computeFees(amount, merchantRate, merchantCap, railRate, railCap, vatRate = VAT_RATE, aggSplitPct = 0) {
  const amt = BigInt(amount);
  const vat = BigInt(Math.round(vatRate * 1_000_000));
  const BASE = 1_000_000n;

  // Merchant fee: rate × amount, then apply cap
  let merchantFeeRaw = amt * BigInt(Math.round(merchantRate * 1_000_000)) / BASE;
  const mCap = BigInt(merchantCap || 0);
  if (mCap > 0n && merchantFeeRaw > mCap) merchantFeeRaw = mCap;
  // Add VAT on merchant fee
  const merchantFeeWithVat = merchantFeeRaw + (merchantFeeRaw * vat / BASE);

  // Rail cost: rate × amount, then apply cap
  let railCostRaw = amt * BigInt(Math.round(railRate * 1_000_000)) / BASE;
  const rCap = BigInt(railCap || 0);
  if (rCap > 0n && railCostRaw > rCap) railCostRaw = rCap;
  // Add VAT on rail cost
  const railCostWithVat = railCostRaw + (railCostRaw * vat / BASE);

  // Net revenue after VAT and caps
  const netRevenue = merchantFeeWithVat - railCostWithVat;

  // Aggregator share
  const aggShare = netRevenue > 0n
    ? netRevenue * BigInt(Math.round(aggSplitPct * 1_000_000)) / BASE
    : 0n;

  const paylodeMargin = netRevenue - aggShare;

  return {
    merchantFeeRaw,       // before VAT
    merchantFeeWithVat,   // what merchant is charged (including VAT)
    railCostRaw,          // before VAT
    railCostWithVat,      // what Paylode pays rail (including VAT)
    netRevenue,
    aggShare,
    paylodeMargin,
    vatOnMerchant:   merchantFeeWithVat - merchantFeeRaw,
    vatOnRail:       railCostWithVat - railCostRaw,
  };
}

/**
 * Intelligent rail routing — finds the lowest cost rail for a service type
 *
 * @param {Object} prisma           Prisma client
 * @param {string} serviceType      VISA | MASTERCARD | VERVE | BANK_TRANSFER | USSD | PAYOUT
 * @param {BigInt} amount           Transaction amount in kobo
 * @param {string|null} designatedRailId  Merchant's designated rail (overrides routing)
 * @param {boolean} allowFallback   Whether to fall back if designated rail unavailable
 */
async function routeTransaction(prisma, serviceType, amount, designatedRailId = null, allowFallback = true) {
  const amt = BigInt(amount);

  // If merchant has designated rail, use it
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

    if (designatedCost.length > 0) {
      return formatRailResult(designatedCost[0], amt);
    }

    // Designated rail not available — fallback if allowed
    if (!allowFallback) {
      throw new Error(`Designated rail not available for ${serviceType} and fallback is disabled`);
    }
  }

  // Get all live rails for this service type and find lowest effective cost
  const rails = await prisma.$queryRaw`
    SELECT rc.*, pr.name as rail_name, pr.id as rail_id
    FROM rail_costs rc
    JOIN payment_rails pr ON rc.rail_id = pr.id
    WHERE rc.service_type = ${serviceType}
      AND rc.effective_to IS NULL
      AND pr.status = 'LIVE'
    ORDER BY rc.rate ASC
  `;

  if (rails.length === 0) {
    throw new Error(`No live rail available for service type: ${serviceType}`);
  }

  // Calculate effective cost for each rail (after cap) and pick lowest
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
    railId:        rail.rail_id || rail.id,
    railName:      rail.rail_name,
    rate,
    cap:           Number(cap),
    vatRate,
    effectiveCost: costWithVat,
    effectiveCostNumber: Number(costWithVat),
    serviceType:   rail.service_type,
    merchantCap:   BigInt(rail.merchant_cap || 0),
  };
}

/**
 * Map payment channel to service type
 * Takes card BIN or channel and returns the correct service type
 */
function channelToServiceType(channel, cardBin = null) {
  const ch = (channel || '').toUpperCase();

  if (ch === 'BANK_TRANSFER') return 'BANK_TRANSFER';
  if (ch === 'USSD')          return 'USSD';
  if (ch === 'DIRECT_DEBIT')  return 'BANK_TRANSFER';
  if (ch === 'PAYOUT')        return 'PAYOUT';

  if (ch === 'CARD' && cardBin) {
    // Detect card scheme from BIN
    const bin = cardBin.toString().substring(0, 6);
    if (bin.startsWith('4'))                           return 'VISA';
    if (/^5[1-5]/.test(bin) || /^2[2-7]/.test(bin))  return 'MASTERCARD';
    if (/^650[0-4]/.test(bin) || bin.startsWith('506')) return 'VERVE';
    return 'VISA'; // default card type
  }

  return 'BANK_TRANSFER'; // safe default
}

module.exports = { computeFees, routeTransaction, channelToServiceType, VAT_RATE };
