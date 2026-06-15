'use strict';
const router = require('express').Router();
const { prisma }  = require('../utils/db');
const { requireAuth, requireCompliance, requireSuperAdmin } = require('../middleware/auth');
const { ok, fail, created, generateRef, koboToNaira } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');
const compliance = require('../services/complianceService');

// ─── CBN Monthly Return ────────────────────────────────────────────────────

router.get('/cbnn-return', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { month } = req.query;
    const base  = month ? new Date(month + '-01') : new Date();
    const start = new Date(base.getFullYear(), base.getMonth(), 1);
    const end   = new Date(base.getFullYear(), base.getMonth() + 1, 0, 23, 59, 59, 999);

    const [totals, byChannel, byMerchantRaw] = await Promise.all([
      prisma.transaction.aggregate({
        where: { createdAt: { gte: start, lte: end }, isSandbox: false },
        _count: { _all: true },
        _sum:   { amount: true, merchantFee: true, paylodeMargin: true, railCost: true },
      }),
      prisma.transaction.groupBy({
        by: ['channel', 'status'],
        where: { createdAt: { gte: start, lte: end }, isSandbox: false },
        _count: { _all: true },
        _sum:   { amount: true },
      }),
      prisma.transaction.groupBy({
        by: ['merchantId', 'status'],
        where: { createdAt: { gte: start, lte: end }, isSandbox: false },
        _count: { _all: true },
        _sum:   { amount: true, merchantFee: true },
      }),
    ]);

    const merchantIds = [...new Set(byMerchantRaw.map(r => r.merchantId))];
    const merchants = merchantIds.length
      ? await prisma.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id:true, businessName:true, merchantCode:true } })
      : [];
    const mMap = Object.fromEntries(merchants.map(m => [m.id, m]));

    const channelMap = {};
    byChannel.forEach(row => {
      const ch = row.channel;
      if (!channelMap[ch]) channelMap[ch] = { success_count:0, failed_count:0, total_volume:0 };
      if (row.status === 'SUCCESS') { channelMap[ch].success_count += row._count._all; channelMap[ch].total_volume += koboToNaira(row._sum.amount || 0n); }
      else channelMap[ch].failed_count += row._count._all;
    });

    const merchantMap = {};
    byMerchantRaw.forEach(row => {
      const id = row.merchantId;
      if (!merchantMap[id]) merchantMap[id] = { merchantCode: mMap[id]?.merchantCode||id, businessName: mMap[id]?.businessName||'Unknown', success_count:0, failed_count:0, total_volume:0, total_fees:0 };
      if (row.status === 'SUCCESS') { merchantMap[id].success_count += row._count._all; merchantMap[id].total_volume += koboToNaira(row._sum.amount||0n); merchantMap[id].total_fees += koboToNaira(row._sum.merchantFee||0n); }
      else merchantMap[id].failed_count += row._count._all;
    });

    ok(res, {
      report_type: 'CBN_MONTHLY_RETURN',
      entity:      'Paylode Services Limited',
      cbn_license: 'CBN/PAY/2024/001847',
      period:      { month: start.toISOString().slice(0,7), start: start.toISOString(), end: end.toISOString() },
      summary: {
        total_transactions: totals._count._all,
        total_volume_ngn:   koboToNaira(totals._sum.amount      || 0n),
        total_fees_ngn:     koboToNaira(totals._sum.merchantFee || 0n),
        total_rail_cost_ngn: koboToNaira(totals._sum.railCost   || 0n),
        paylode_net_ngn:    koboToNaira(totals._sum.paylodeMargin || 0n),
      },
      by_channel:  channelMap,
      by_merchant: Object.values(merchantMap).sort((a,b) => b.total_volume - a.total_volume),
      generated_at: new Date().toISOString(),
    });
  } catch(e) { next(e); }
});

// ─── AML Flags (for STR context) ──────────────────────────────────────────

router.get('/aml-flags', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const flags = await prisma.amlFlag.findMany({
      where: { status: { in: ['OPEN', 'INVESTIGATING'] } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        merchant:    { select: { businessName:true, merchantCode:true } },
        transaction: { select: { reference:true, amount:true, channel:true } },
      },
    });
    ok(res, flags);
  } catch(e) { next(e); }
});

// ─── STR Filing ────────────────────────────────────────────────────────────

router.get('/str', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status } = req.query;
    const filings = await prisma.strFiling.findMany({
      where:   status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: { merchant: { select: { businessName:true, merchantCode:true } } },
    });
    ok(res, filings);
  } catch(e) { next(e); }
});

router.post('/str', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { merchantId, transactionRefs, narrative, riskLevel } = req.body;
    if (!narrative || !riskLevel) return fail(res, 'narrative and riskLevel are required');
    const filing = await prisma.strFiling.create({
      data: { reference: generateRef('STR'), merchantId: merchantId || null, transactionRefs: transactionRefs || [], narrative, riskLevel, status: 'draft', filedBy: req.user.id },
    });
    ok(res, filing, 'STR filing created');
  } catch(e) { next(e); }
});

router.patch('/str/:id/submit', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { nfiuRef } = req.body;
    const filing = await prisma.strFiling.update({
      where: { id: req.params.id },
      data:  { status: 'submitted', filedAt: new Date(), nfiuRef: nfiuRef || null },
    });
    ok(res, filing, 'STR submitted to NFIU');
  } catch(e) { next(e); }
});

router.patch('/str/:id', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { narrative, riskLevel, transactionRefs } = req.body;
    const data = {};
    if (narrative)       data.narrative       = narrative;
    if (riskLevel)       data.riskLevel       = riskLevel;
    if (transactionRefs) data.transactionRefs = transactionRefs;
    ok(res, await prisma.strFiling.update({ where: { id: req.params.id }, data }));
  } catch(e) { next(e); }
});

// ─── Data Retention ────────────────────────────────────────────────────────

router.get('/retention', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const now = new Date();
    const y1 = new Date(now); y1.setFullYear(y1.getFullYear() - 1);
    const y3 = new Date(now); y3.setFullYear(y3.getFullYear() - 3);
    const y7 = new Date(now); y7.setFullYear(y7.getFullYear() - 7);

    const [[u1, u3, u7, o7], userCount, kycCount, auditCount, oldest] = await Promise.all([
      Promise.all([
        prisma.transaction.count({ where: { createdAt: { gte: y1 } } }),
        prisma.transaction.count({ where: { createdAt: { gte: y3, lt: y1 } } }),
        prisma.transaction.count({ where: { createdAt: { gte: y7, lt: y3 } } }),
        prisma.transaction.count({ where: { createdAt: { lt: y7 } } }),
      ]),
      prisma.user.count(),
      prisma.kycSubmission.count(),
      prisma.auditLog.count(),
      prisma.transaction.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);

    ok(res, {
      policy: { min_retention_years: 7, regulation: 'BOFIA 2020 + CBN AML/CFT Guidelines' },
      transactions: { under_1yr: u1, '1_to_3yr': u3, '3_to_7yr': u7, over_7yr: o7, oldest_record: oldest?.createdAt || null, compliant: o7 === 0 },
      other_records: { user_accounts: userCount, kyc_submissions: kycCount, audit_logs: auditCount },
      status: o7 === 0 ? 'COMPLIANT' : 'RECORDS_EXIST_PAST_7YR',
    });
  } catch(e) { next(e); }
});

// ─── NDPR Data Subject Requests ────────────────────────────────────────────

router.get('/dsr', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status } = req.query;
    ok(res, await prisma.dataSubjectRequest.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' } }));
  } catch(e) { next(e); }
});

router.post('/dsr', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { subjectName, subjectEmail, requestType, details } = req.body;
    if (!subjectName || !subjectEmail || !requestType || !details)
      return fail(res, 'subjectName, subjectEmail, requestType, and details are required');
    created(res, await prisma.dataSubjectRequest.create({
      data: { reference: generateRef('DSR'), subjectName, subjectEmail, requestType, details, status: 'pending' },
    }), 'Data subject request logged');
  } catch(e) { next(e); }
});

router.patch('/dsr/:id/fulfill', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { responseNotes } = req.body;
    ok(res, await prisma.dataSubjectRequest.update({
      where: { id: req.params.id },
      data:  { status: 'fulfilled', fulfilledAt: new Date(), handledBy: req.user.id, responseNotes: responseNotes || null },
    }), 'Request fulfilled');
  } catch(e) { next(e); }
});

router.patch('/dsr/:id/reject', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { responseNotes } = req.body;
    ok(res, await prisma.dataSubjectRequest.update({
      where: { id: req.params.id },
      data:  { status: 'rejected', handledBy: req.user.id, responseNotes: responseNotes || null },
    }), 'Request rejected');
  } catch(e) { next(e); }
});

// ─── Compliance exceptions (Mastercard Rules screening dispositions) ─────────
// SA-driven defer / clear / block workflow over compliance_exceptions. A merchant
// is re-rolled-up + (de)activated as its exceptions are dispositioned, mirroring the
// per-document deferral pattern in routes/documents.js.

const VALID_DURATIONS = [1, 2, 3, 6];
const VALID_ENTITY = new Set(['merchant', 'aggregator', 'transaction']);

async function getException(id) {
  const [row] = await prisma.$queryRaw`
    SELECT id::text, entity_type, entity_id::text, rule_code, severity, status,
           description, rule_ref, deferrable, deferred_until, reason
    FROM compliance_exceptions WHERE id = ${id}::uuid`;
  return row || null;
}

// Recompute merchant compliance_status + (de)activate based on remaining exceptions.
async function reconcileMerchant(merchantId) {
  const status = await compliance.rollupComplianceStatus(merchantId);
  if (status === 'blocked') {
    await prisma.merchant.update({ where: { id: merchantId }, data: { isActive: false, kycStatus: 'SUSPENDED' } });
  }
  return status;
}

// GET /api/v1/compliance/exceptions?entity_type=&entity_id=&status=
router.get('/exceptions', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { entity_type, entity_id, status } = req.query;
    const rows = await prisma.$queryRaw`
      SELECT ce.id::text, ce.entity_type, ce.entity_id::text, ce.rule_code, ce.severity,
             ce.status, ce.description, ce.rule_ref, ce.deferrable, ce.deferred_until,
             ce.deferred_by::text, ce.reason, ce.created_at, ce.updated_at,
             m.business_name AS merchant_name
      FROM compliance_exceptions ce
      LEFT JOIN merchants m ON m.id = ce.entity_id AND ce.entity_type='merchant'
      WHERE (${entity_type || null}::text IS NULL OR ce.entity_type = ${entity_type || null})
        AND (${entity_id || null}::uuid IS NULL OR ce.entity_id = ${entity_id || null}::uuid)
        AND (${status || null}::text IS NULL OR ce.status = ${status || null})
      ORDER BY (ce.severity='BLOCKING') DESC, (ce.status='open') DESC, ce.created_at DESC
      LIMIT 500`;
    const summary = rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    ok(res, { exceptions: rows, summary });
  } catch (e) { next(e); }
});

// POST /api/v1/compliance/exceptions/:id/defer — SA defers and proceeds.
// Non-deferrable (absolute prohibition) requires force:true + ack (SUPER_ADMIN only).
router.post('/exceptions/:id/defer', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { duration_months, reason, force } = req.body;
    if (!VALID_DURATIONS.includes(Number(duration_months))) return fail(res, 'duration_months must be 1, 2, 3 or 6');
    const ex = await getException(req.params.id);
    if (!ex) return fail(res, 'Exception not found', 'NOT_FOUND', 404);
    if (!ex.deferrable && !force)
      return fail(res, 'This is an absolute prohibition and cannot be deferred. Pass force:true to override (logged, SUPER_ADMIN only).', 'NOT_DEFERRABLE', 409);
    if (!ex.deferrable && !reason)
      return fail(res, 'A reason is required to force-override an absolute prohibition.', 'REASON_REQUIRED');

    const expiresAt = new Date(); expiresAt.setMonth(expiresAt.getMonth() + Number(duration_months));
    await prisma.$executeRaw`
      UPDATE compliance_exceptions SET status='deferred', deferred_until=${expiresAt},
             deferred_by=${req.user.id}::uuid, reason=${reason || null}, updated_at=now()
      WHERE id=${req.params.id}::uuid`;
    if (ex.entity_type === 'merchant') await reconcileMerchant(ex.entity_id);
    await logAudit(req.user.id, ex.deferrable ? 'COMPLIANCE_EXCEPTION_DEFERRED' : 'COMPLIANCE_EXCEPTION_FORCE_OVERRIDE',
      'compliance_exceptions', req.params.id, {}, { rule_code: ex.rule_code, duration_months, expires_at: expiresAt, reason, force: !!force });
    ok(res, await getException(req.params.id), `Exception deferred until ${expiresAt.toDateString()}.`);
  } catch (e) { next(e); }
});

// POST /api/v1/compliance/exceptions/:id/clear — false positive / resolved.
router.post('/exceptions/:id/clear', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const ex = await getException(req.params.id);
    if (!ex) return fail(res, 'Exception not found', 'NOT_FOUND', 404);
    await prisma.$executeRaw`
      UPDATE compliance_exceptions SET status='cleared', deferred_until=NULL,
             deferred_by=${req.user.id}::uuid, reason=${reason || null}, updated_at=now()
      WHERE id=${req.params.id}::uuid`;
    if (ex.entity_type === 'merchant') await reconcileMerchant(ex.entity_id);
    await logAudit(req.user.id, 'COMPLIANCE_EXCEPTION_CLEARED', 'compliance_exceptions', req.params.id, {}, { rule_code: ex.rule_code, reason });
    ok(res, await getException(req.params.id), 'Exception cleared.');
  } catch (e) { next(e); }
});

// POST /api/v1/compliance/exceptions/:id/block — confirm the block (suspends merchant).
router.post('/exceptions/:id/block', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const ex = await getException(req.params.id);
    if (!ex) return fail(res, 'Exception not found', 'NOT_FOUND', 404);
    await prisma.$executeRaw`
      UPDATE compliance_exceptions SET status='blocked', deferred_until=NULL,
             deferred_by=${req.user.id}::uuid, reason=${reason || null}, updated_at=now()
      WHERE id=${req.params.id}::uuid`;
    if (ex.entity_type === 'merchant') await reconcileMerchant(ex.entity_id);
    await logAudit(req.user.id, 'COMPLIANCE_EXCEPTION_BLOCKED', 'compliance_exceptions', req.params.id, {}, { rule_code: ex.rule_code, reason });
    ok(res, await getException(req.params.id), 'Exception confirmed — merchant blocked.');
  } catch (e) { next(e); }
});

// GET /api/v1/compliance/matrix — the prohibited/restricted MCC + BRAM reference matrix.
router.get('/matrix', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const rules = require('../config/complianceRules');
    const mccs = Object.entries(rules.MCC_CATALOGUE).map(([code, v]) => ({
      mcc: code, label: v.label, local: v.base, international: v.intl || v.base,
    }));
    ok(res, { mccs, bram: rules.BRAM_CATEGORIES, reason_codes: rules.REASON_CODES });
  } catch (e) { next(e); }
});

module.exports = router;
