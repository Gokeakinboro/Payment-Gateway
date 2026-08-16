'use strict';
// Physical access control API for Social Club merchants.
// GET /api/v1/wallet/access/:memberId   — API-key auth, returns paid-up status.
// The physical gate/door system calls this with the club's API key to decide
// whether a member (identified by their member ID from a card/QR scan) gets entry.
const router = require('express').Router();
const { prisma } = require('../_shared');
const { requireApiKey } = require('../../../middleware/auth');
const { ok, notFound } = require('../../../utils/helpers');

router.get('/:memberId', requireApiKey, async (req, res, next) => {
  try {
    const mid = req.merchant && req.merchant.id;
    const memberId = req.params.memberId;

    const mrows = await prisma.$queryRawUnsafe(
      `SELECT id::text, name, status FROM mw_members WHERE id=$1::uuid AND merchant_id=$2::uuid`,
      memberId, mid);
    if (!mrows.length) return notFound(res, 'Member');
    const member = mrows[0];

    if (member.status !== 'active') {
      return ok(res, { member_id: memberId, name: member.name, paid_up: false, blocked_reason: 'membership_suspended' });
    }

    // Blocked if any club invoice is past due_at + grace_period_days and unpaid.
    const overdue = await prisma.$queryRawUnsafe(
      `SELECT i.invoice_number
         FROM inv_invoices i
         JOIN club_subscription_plans p ON p.id=i.club_plan_id
        WHERE i.club_member_id=$1::uuid AND i.merchant_id=$2::uuid
          AND i.status NOT IN ('paid','cancelled') AND i.deleted_at IS NULL
          AND i.due_at IS NOT NULL
          AND i.due_at + (p.grace_period_days::text || ' days')::interval < now()
        LIMIT 1`,
      memberId, mid);

    if (overdue.length) {
      return ok(res, {
        member_id: memberId, name: member.name, paid_up: false,
        blocked_reason: 'overdue_invoice', overdue_invoice: overdue[0].invoice_number,
      });
    }
    return ok(res, { member_id: memberId, name: member.name, paid_up: true, blocked_reason: null });
  } catch (e) { next(e); }
});

module.exports = router;
