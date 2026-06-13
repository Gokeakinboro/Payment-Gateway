'use strict';
const router = require('express').Router();
const { prisma }  = require('../utils/db');
const { requireAuth, requireCompliance } = require('../middleware/auth');
const { ok, fail, created, generateRef, koboToNaira } = require('../utils/helpers');

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

module.exports = router;
