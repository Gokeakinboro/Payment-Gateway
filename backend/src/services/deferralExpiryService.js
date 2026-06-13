'use strict';
const { prisma }  = require('../utils/db');
const { logger }  = require('../utils/logger');

async function expireOverdueDeferrals() {
  try {
    const now = new Date();
    const expired = await prisma.$queryRaw`
      SELECT entity_type, entity_id::text
      FROM document_deferrals
      WHERE status = 'active' AND expires_at <= ${now}
    `;
    if (!expired.length) return 0;

    for (const d of expired) {
      await prisma.$executeRaw`
        UPDATE document_deferrals SET status = 'expired'
        WHERE entity_type = ${d.entity_type} AND entity_id = ${d.entity_id}::uuid
          AND status = 'active' AND expires_at <= ${now}
      `;

      if (d.entity_type === 'merchant') {
        await prisma.merchant.update({
          where:{ id: d.entity_id },
          data:{ isActive:false, kycStatus:'SUSPENDED' },
        });
      } else if (d.entity_type === 'aggregator') {
        await prisma.aggregator.update({
          where:{ id: d.entity_id },
          data:{ status:'suspended' },
        });
      }

      logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id },
        'Document deferral expired — account suspended');
    }

    logger.info({ count:expired.length }, 'Deferral expiry check completed');
    return expired.length;
  } catch(err) {
    logger.error({ err }, 'Deferral expiry check failed');
    return 0;
  }
}

// Run on startup, then every hour
expireOverdueDeferrals();
setInterval(expireOverdueDeferrals, 60 * 60 * 1000);

module.exports = { expireOverdueDeferrals };
