'use strict';
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');

// This service is loaded by every PM2 cluster worker (6×), so the hourly sweep
// would otherwise run 6 times concurrently and race on the same rows / suspend
// accounts repeatedly. We gate each sweep behind a Postgres TRANSACTION-level
// advisory lock (pg_try_advisory_xact_lock): exactly one worker acquires it and
// runs; the rest get `false` and skip. A *transaction* lock (not a session lock)
// is required because Prisma pools connections — the lock is held on, and the
// sweep runs on, the same connection, and it auto-releases on commit.
const SWEEP_LOCK_KEY = 9110013;

// Whole-account deferral expiry (legacy document_deferrals table).
async function expireOverdueDeferrals(db, now) {
  const expired = await db.$queryRaw`
    SELECT entity_type, entity_id::text FROM document_deferrals
    WHERE status = 'active' AND expires_at <= ${now}`;
  for (const d of expired) {
    await db.$executeRaw`
      UPDATE document_deferrals SET status='expired'
      WHERE entity_type=${d.entity_type} AND entity_id=${d.entity_id}::uuid AND status='active' AND expires_at <= ${now}`;
    if (d.entity_type === 'merchant')        await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
    else if (d.entity_type === 'aggregator') await db.aggregator.update({ where:{ id:d.entity_id }, data:{ status:'suspended' } });
    logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id }, 'Document deferral expired — account suspended');
  }
  return expired.length;
}

// Per-DOCUMENT deferral expiry — a single document deferred past its date that is
// still not submitted/verified becomes 'overdue' and suspends the account, so an
// individual outstanding document can't slip through the cracks.
async function expireOverdueDocuments(db, now) {
  const overdue = await db.$queryRaw`
    SELECT DISTINCT entity_type, entity_id::text FROM kyc_documents
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  await db.$executeRaw`
    UPDATE kyc_documents SET status='overdue', updated_at=now()
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  for (const d of overdue) {
    if (d.entity_type === 'merchant')        await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
    else if (d.entity_type === 'aggregator') await db.aggregator.update({ where:{ id:d.entity_id }, data:{ status:'suspended' } });
    logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id }, 'KYC document deferral overdue — account suspended');
  }
  return overdue.length;
}

// Compliance-exception deferral expiry — a deferred compliance exception whose date
// has passed reverts to 'open'. The merchant's rolled-up compliance_status is
// recomputed; if it has any open BLOCKING exception it is suspended so a deferred
// prohibition can't quietly outlive its grace period.
async function expireComplianceDeferrals(db, now) {
  const expired = await db.$queryRaw`
    SELECT DISTINCT entity_type, entity_id::text FROM compliance_exceptions
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  await db.$executeRaw`
    UPDATE compliance_exceptions SET status='open', updated_at=now()
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  for (const d of expired) {
    if (d.entity_type !== 'merchant') continue;
    const [row] = await db.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE severity='BLOCKING' AND status IN ('open','blocked'))::int AS blocking,
        COUNT(*) FILTER (WHERE severity='REVIEW'   AND status='open')::int                AS review
      FROM compliance_exceptions WHERE entity_type='merchant' AND entity_id=${d.entity_id}::uuid`;
    const status = row.blocking > 0 ? 'blocked' : row.review > 0 ? 'review' : 'clear';
    await db.$executeRaw`UPDATE merchants SET compliance_status=${status} WHERE id=${d.entity_id}::uuid`;
    if (row.blocking > 0) {
      await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
      logger.warn({ entity_id:d.entity_id }, 'Compliance deferral expired with open BLOCKING — merchant suspended');
    }
  }
  return expired.length;
}

// Single cluster-wide sweep, protected by the advisory lock.
async function runSweeps() {
  try {
    await prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS locked`;
      if (!locked) return; // another worker is already sweeping
      const now = new Date();
      const a = await expireOverdueDeferrals(tx, now);
      const b = await expireOverdueDocuments(tx, now);
      const c = await expireComplianceDeferrals(tx, now);
      if (a || b || c) logger.info({ deferrals:a, documents:b, compliance:c }, 'KYC expiry sweep completed');
    }, { timeout: 60000 });
  } catch (err) {
    logger.error({ err }, 'KYC expiry sweep failed');
  }
}

// Run shortly after startup (staggered so workers don't all fire at once), then hourly.
setTimeout(runSweeps, Math.floor(Math.random() * 5000) + 1000);
setInterval(runSweeps, 60 * 60 * 1000);

module.exports = { runSweeps, expireOverdueDeferrals, expireOverdueDocuments, expireComplianceDeferrals };
