'use strict';
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');
const { logAudit } = require('./auditService');
const { notifyApprovers } = require('./approvalNotify');

// This service is loaded by every PM2 cluster worker (6×), so the hourly sweep
// would otherwise run 6 times concurrently and race on the same rows / suspend
// accounts repeatedly. We gate each sweep behind a Postgres TRANSACTION-level
// advisory lock (pg_try_advisory_xact_lock): exactly one worker acquires it and
// runs; the rest get `false` and skip. A *transaction* lock (not a session lock)
// is required because Prisma pools connections — the lock is held on, and the
// sweep runs on, the same connection, and it auto-releases on commit.
const SWEEP_LOCK_KEY = 9110013;

// Whole-account deferral expiry (legacy document_deferrals table).
async function expireOverdueDeferrals(db, now, suspended) {
  const expired = await db.$queryRaw`
    SELECT entity_type, entity_id::text FROM document_deferrals
    WHERE status = 'active' AND expires_at <= ${now}`;
  for (const d of expired) {
    await db.$executeRaw`
      UPDATE document_deferrals SET status='expired'
      WHERE entity_type=${d.entity_type} AND entity_id=${d.entity_id}::uuid AND status='active' AND expires_at <= ${now}`;
    if (d.entity_type === 'merchant') {
      const m = await db.merchant.findUnique({ where:{ id:d.entity_id }, select:{ businessName:true } });
      await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
      logAudit(null, 'MERCHANT_SUSPENDED', 'merchants', d.entity_id, { isActive:true }, { isActive:false, kycStatus:'SUSPENDED' }, 'Document deferral expired — auto-suspended by cron');
      suspended.push({ id:d.entity_id, name: m?.businessName || d.entity_id, reason:'Document deferral period expired' });
    } else if (d.entity_type === 'aggregator') {
      await db.aggregator.update({ where:{ id:d.entity_id }, data:{ status:'suspended' } });
    }
    logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id }, 'Document deferral expired — account suspended');
  }
  return expired.length;
}

// Per-DOCUMENT deferral expiry — a single document deferred past its date that is
// still not submitted/verified becomes 'overdue' and suspends the account, so an
// individual outstanding document can't slip through the cracks.
async function expireOverdueDocuments(db, now, suspended) {
  const overdue = await db.$queryRaw`
    SELECT DISTINCT entity_type, entity_id::text FROM kyc_documents
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  await db.$executeRaw`
    UPDATE kyc_documents SET status='overdue', updated_at=now()
    WHERE status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= ${now}`;
  for (const d of overdue) {
    if (d.entity_type === 'merchant') {
      const m = await db.merchant.findUnique({ where:{ id:d.entity_id }, select:{ businessName:true } });
      await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
      logAudit(null, 'MERCHANT_SUSPENDED', 'merchants', d.entity_id, { isActive:true }, { isActive:false, kycStatus:'SUSPENDED' }, 'KYC document overdue — auto-suspended by cron');
      suspended.push({ id:d.entity_id, name: m?.businessName || d.entity_id, reason:'KYC document deferral period overdue' });
    } else if (d.entity_type === 'aggregator') {
      await db.aggregator.update({ where:{ id:d.entity_id }, data:{ status:'suspended' } });
    }
    logger.warn({ entity_type:d.entity_type, entity_id:d.entity_id }, 'KYC document deferral overdue — account suspended');
  }
  return overdue.length;
}

// Compliance-exception deferral expiry — a deferred compliance exception whose date
// has passed reverts to 'open'. The merchant's rolled-up compliance_status is
// recomputed; if it has any open BLOCKING exception it is suspended so a deferred
// prohibition can't quietly outlive its grace period.
async function expireComplianceDeferrals(db, now, suspended) {
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
      const m = await db.merchant.findUnique({ where:{ id:d.entity_id }, select:{ businessName:true } });
      await db.merchant.update({ where:{ id:d.entity_id }, data:{ isActive:false, kycStatus:'SUSPENDED' } });
      logAudit(null, 'MERCHANT_SUSPENDED', 'merchants', d.entity_id, { isActive:true }, { isActive:false, kycStatus:'SUSPENDED' }, 'Compliance deferral expired with open BLOCKING exception — auto-suspended by cron');
      suspended.push({ id:d.entity_id, name: m?.businessName || d.entity_id, reason:'Compliance exception deferral expired — BLOCKING rule now active' });
      logger.warn({ entity_id:d.entity_id }, 'Compliance deferral expired with open BLOCKING — merchant suspended');
    }
  }
  return expired.length;
}

// Single cluster-wide sweep, protected by the advisory lock.
async function runSweeps() {
  const suspended = [];
  try {
    await prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS locked`;
      if (!locked) return; // another worker is already sweeping
      const now = new Date();
      const a = await expireOverdueDeferrals(tx, now, suspended);
      const b = await expireOverdueDocuments(tx, now, suspended);
      const c = await expireComplianceDeferrals(tx, now, suspended);
      if (a || b || c) logger.info({ deferrals:a, documents:b, compliance:c }, 'KYC expiry sweep completed');
    }, { timeout: 60000 });
  } catch (err) {
    logger.error({ err }, 'KYC expiry sweep failed');
  }
  // Email SA/Admin after the transaction commits — fire-and-forget.
  if (suspended.length) {
    const rows = suspended.map(s => `<li><strong>${s.name}</strong> — ${s.reason} <span style="color:#888;font-size:12px">(${s.id})</span></li>`).join('');
    notifyApprovers({
      subject: `[Paylode] ${suspended.length} merchant${suspended.length > 1 ? 's' : ''} auto-suspended — deferral expiry`,
      summaryHtml: `<p>The following merchant${suspended.length > 1 ? 's were' : ' was'} automatically suspended by the KYC/compliance deferral expiry cron:</p><ul>${rows}</ul><p>Review their status and reactivate or take action as appropriate.</p>`,
      actionUrl: null,
    });
  }
}

// Run shortly after startup (staggered so workers don't all fire at once), then hourly.
setTimeout(runSweeps, Math.floor(Math.random() * 5000) + 1000);
setInterval(runSweeps, 60 * 60 * 1000);

module.exports = { runSweeps, expireOverdueDeferrals, expireOverdueDocuments, expireComplianceDeferrals };
