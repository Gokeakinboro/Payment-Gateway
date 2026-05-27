'use strict';
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');

const RULES = [
  // Single transaction > 80% of single limit
  async (txn, merchant) => {
    const limits = { 1: 5_000_000n, 2: 100_000_000n, 3: 500_000_000n };
    const limit  = limits[merchant.kycTier] || 5_000_000n;
    if (txn.amount > limit * 80n / 100n) {
      return { flagType:'LARGE_TXN', riskLevel:'HIGH', description:`Transaction ₦${Number(txn.amount)/100} is >80% of single limit` };
    }
  },
  // Velocity — more than 20 txns in 2 hours
  async (txn, merchant) => {
    const twoHoursAgo = new Date(Date.now() - 2*60*60*1000);
    const count = await prisma.transaction.count({
      where: { merchantId: merchant.id, createdAt: { gte: twoHoursAgo }, isSandbox: false },
    });
    if (count > 20) {
      return { flagType:'VELOCITY', riskLevel:'CRITICAL', description:`${count} transactions in last 2 hours` };
    }
  },
  // Round number pattern — 5+ round-number txns today
  async (txn, merchant) => {
    if (Number(txn.amount) % 100000 !== 0) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const roundCount = await prisma.$queryRaw`
      SELECT COUNT(*) FROM transactions
      WHERE merchant_id = ${merchant.id}
        AND MOD(amount::int, 100000) = 0
        AND created_at >= ${today}
        AND is_sandbox = false
    `;
    if (Number(roundCount[0].count) >= 5) {
      return { flagType:'ROUND_AMOUNTS', riskLevel:'MEDIUM', description:'Multiple round-number transactions detected today' };
    }
  },
];

async function checkAmlRules(txn, merchant) {
  for (const rule of RULES) {
    try {
      const flag = await rule(txn, merchant);
      if (flag) {
        await prisma.amlFlag.create({ data: {
          merchantId:    merchant.id,
          transactionId: txn.id,
          flagType:      flag.flagType,
          riskLevel:     flag.riskLevel,
          status:        'OPEN',
          description:   flag.description,
        }});
        logger.warn({ merchantId:merchant.id, txnRef:txn.reference, ...flag }, 'AML flag raised');
      }
    } catch (e) {
      logger.error({ err:e }, 'AML rule error');
    }
  }
}

module.exports = { checkAmlRules };
