'use strict';
// Reporting — status summary + a collections log (invoice + QR payments), CSV-exportable.
// Departmental users see only their own department's collections.
const router = require('express').Router();
const { prisma, tenantAuth } = require('../_shared');
const { ok } = require('../../../utils/helpers');

router.use(tenantAuth);

const deptOf = (req) => (req.invTenant.isDeptUser ? req.invTenant.departmentId : null);

// Invoice status counts + amount collected.
router.get('/summary', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId; const dept = deptOf(req);
    const deptClause = dept ? ` AND department_id = $2::uuid` : '';
    const vals = dept ? [mid, dept] : [mid];
    const counts = await prisma.$queryRawUnsafe(
      `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::text AS total
         FROM inv_invoices WHERE merchant_id = $1::uuid${deptClause} GROUP BY status`, ...vals);
    const overdue = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM inv_invoices WHERE merchant_id=$1::uuid${deptClause} AND is_overdue = true`, ...vals);
    const collected = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(amount_paid),0)::text AS total FROM inv_invoices WHERE merchant_id=$1::uuid${deptClause}`, ...vals);
    const by = {};
    counts.forEach((c) => { by[c.status] = { count: c.n, total: Number(c.total) }; });
    return ok(res, { by_status: by, overdue: overdue[0].n, total_collected: Number(collected[0].total) });
  } catch (e) { next(e); }
});

// Collections log (paid invoice + QR rows). ?format=csv for download.
router.get('/transactions', async (req, res, next) => {
  try {
    const mid = req.invTenant.merchantId; const dept = deptOf(req);
    const deptInv = dept ? ` AND i.department_id = $2::uuid` : '';
    const deptQr = dept ? ` AND q.department_id = $2::uuid` : '';
    const vals = dept ? [mid, dept] : [mid];
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM (
         SELECT ip.paid_at, 'invoice' AS kind, i.invoice_number AS ref, i.recipient_email AS payer,
                ip.amount_paid::text AS amount, ip.payment_reference, i.department_id::text AS department_id
           FROM inv_invoice_payments ip JOIN inv_invoices i ON i.id = ip.invoice_id
          WHERE i.merchant_id = $1::uuid${deptInv}
         UNION ALL
         SELECT qp.paid_at, 'qr' AS kind, COALESCE(q.label, q.qr_reference) AS ref, NULL AS payer,
                qp.amount_paid::text AS amount, qp.payment_reference, q.department_id::text AS department_id
           FROM inv_qr_payments qp JOIN inv_qr_codes q ON q.id = qp.qr_code_id
          WHERE q.merchant_id = $1::uuid${deptQr}
       ) t ORDER BY paid_at DESC LIMIT 5000`, ...vals);

    if (req.query.format === 'csv') {
      const header = 'paid_at,kind,reference,payer,amount_naira,payment_reference\n';
      const body = rows.map((r) => [
        new Date(r.paid_at).toISOString(), r.kind, r.ref || '', r.payer || '',
        (Number(r.amount) / 100).toFixed(2), r.payment_reference || '',
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      res.type('text/csv').set('Content-Disposition', 'attachment; filename="collections.csv"');
      return res.send(header + body);
    }
    return ok(res, rows.map((r) => ({ ...r, amount: Number(r.amount) })));
  } catch (e) { next(e); }
});

module.exports = router;
