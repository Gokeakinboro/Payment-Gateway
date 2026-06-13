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

// Per-DOCUMENT deferral expiry. A document deferred past its date that is still
// not submitted/verified becomes 'overdue' and the account is suspended — this is
// what stops an individual outstanding document from slipping through the cracks.
async function expireOverdueDocuments() {
  try {
    const now = new Date();
    const overdue = await prisma.$queryRaw`
      SELECT DISTINCT entity_type, entity_id::text
      FROM kyc_documents
      WHERE status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}
    `;
    await prisma.$executeRaw`
      UPDATE kyc_documents SET status = 'overdue', updated_at = now()
      WHERE status = 'deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}
    `;
    for (const d of overdue) {
      if (d.entity_type === 'merchant') {
        await prisma.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
      } else if (d.entity_type === 'aggregator') {
        await prisma.aggregator.update({ where:{ id:d.entity_id }, data:{ status:'suspended' } });
      }
      logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id },
        'KYC document deferral overdue — account suspended');
    }
    if (overdue.length) logger.info({ count:overdue.length }, 'Document overdue check completed');
    return overdue.length;
  } catch(err) {
    logger.error({ err }, 'Document overdue check failed');
    return 0;
  }
}

// Run on startup, then every hour
expireOverdueDeferrals();
expireOverdueDocuments();
setInterval(expireOverdueDeferrals, 60 * 60 * 1000);
setInterval(expireOverdueDocuments, 60 * 60 * 1000);

module.exports = { expireOverdueDeferrals, expireOverdueDocuments };
