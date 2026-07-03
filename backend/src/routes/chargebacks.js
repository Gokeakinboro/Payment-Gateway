'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, fail, created } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');

const notFoundResp = (res, msg) => res.status(404).json({ status: false, message: msg || 'Not found' });

// GET /api/v1/chargebacks
router.get('/', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { page = 1, perPage = 50, status, merchantId } = req.query;
    const where = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = merchantId;
    const [rows, total] = await Promise.all([
      prisma.chargeback.findMany({
        where, orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(perPage), take: parseInt(perPage),
        include: { merchant: { select: { businessName: true, merchantCode: true } } },
      }),
      prisma.chargeback.count({ where }),
    ]);
    ok(res, {
      data: rows.map(c => ({ ...c, amount: c.amount.toString() })),
      meta: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(perPage)) },
    });
  } catch (e) { next(e); }
});

// POST /api/v1/chargebacks
router.post('/', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { transaction_ref, merchant_id, amount_naira, reason, raised_by, due_date } = req.body;
    if (!transaction_ref || !merchant_id || !amount_naira || !reason)
      return fail(res, 'transaction_ref, merchant_id, amount_naira, reason required');
    const cb = await prisma.chargeback.create({
      data: {
        transactionRef: transaction_ref, merchantId: merchant_id,
        amount: BigInt(Math.round(parseFloat(amount_naira) * 100)),
        reason, raisedBy: raised_by || 'admin',
        dueDate: due_date ? new Date(due_date) : null, evidence: [],
      },
    });
    await logAudit(req.user.id, 'CHARGEBACK_RAISED', 'chargebacks', cb.id,
      null, { transaction_ref, merchant_id, reason }, null, req.ip);
    created(res, { ...cb, amount: cb.amount.toString() }, 'Chargeback raised');
  } catch (e) { next(e); }
});

// POST /api/v1/chargebacks/:id/evidence
router.post('/:id/evidence', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const cb = await prisma.chargeback.findUnique({ where: { id: req.params.id } });
    if (!cb) return notFoundResp(res, 'Chargeback not found');
    const { type, description, url } = req.body;
    const ev = [
      ...(Array.isArray(cb.evidence) ? cb.evidence : []),
      { type: type || 'note', description, url: url || null, addedAt: new Date().toISOString(), addedBy: req.user.email },
    ];
    const u = await prisma.chargeback.update({
      where: { id: req.params.id }, data: { status: 'under_review', evidence: ev },
    });
    ok(res, { ...u, amount: u.amount.toString() }, 'Evidence added');
  } catch (e) { next(e); }
});

// PUT /api/v1/chargebacks/:id/resolve
router.put('/:id/resolve', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { outcome, notes } = req.body;
    if (!['won', 'lost', 'accepted'].includes(outcome))
      return fail(res, 'outcome must be won, lost, or accepted');
    const before = await prisma.chargeback.findUnique({ where: { id: req.params.id } });
    if (!before) return notFoundResp(res, 'Chargeback not found');
    const u = await prisma.chargeback.update({
      where: { id: req.params.id },
      data: { status: outcome, resolutionNotes: notes || null, resolvedAt: new Date(), resolvedBy: req.user.id },
    });
    await logAudit(req.user.id, 'CHARGEBACK_RESOLVED', 'chargebacks', req.params.id,
      { status: before.status }, { status: outcome, notes }, notes, req.ip);
    ok(res, { ...u, amount: u.amount.toString() }, 'Chargeback resolved');
  } catch (e) { next(e); }
});

module.exports = router;
