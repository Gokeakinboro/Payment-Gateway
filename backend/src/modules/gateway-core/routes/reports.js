'use strict';
const router     = require('express').Router();
const nodemailer = require('nodemailer');
const { prisma } = require('../../../utils/db');
const { requireAuth, requireCompliance, requireSuperAdmin } = require('../../../middleware/auth');
const { ok, fail, koboToNaira } = require('../../../utils/helpers');

function getMailer() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ── GET /api/v1/reports/vat?month=YYYY-MM — monthly VAT report (per product) ──
// Net VAT payable = output VAT (charged on Paylode fees) − input VAT (charged by
// rails). Per-product breakdown + payout-fee VAT. Returns JSON; the dashboard
// builds the downloadable Excel client-side.
router.get('/vat', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const now = new Date();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const start = new Date(month + '-01T00:00:00.000Z');
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);

    // Transactions (cards / VA / USSD …): output + input VAT per product.
    const txnRows = await prisma.$queryRaw`
      SELECT COALESCE(metadata->>'product', channel::text) AS product,
             COUNT(*)::int AS txn_count,
             COALESCE(SUM(amount),0)       AS volume,
             COALESCE(SUM(merchant_fee),0) AS fee_incl_vat,
             COALESCE(SUM(vat_output),0)   AS output_vat,
             COALESCE(SUM(vat_input),0)    AS input_vat
      FROM transactions
      WHERE status = 'SUCCESS' AND is_sandbox = false
        AND paid_at >= ${start} AND paid_at < ${end}
      GROUP BY 1 ORDER BY 1
    `;

    // Payouts: output VAT collected on payout fees (wallet_ledger VAT entries).
    const payoutVat = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0) AS output_vat
      FROM wallet_ledger
      WHERE entry_type = 'VAT' AND created_at >= ${start} AND created_at < ${end}
    `;

    const products = txnRows.map(r => {
      const out = Number(r.output_vat), inp = Number(r.input_vat);
      return {
        product:            r.product || 'UNKNOWN',
        txn_count:          r.txn_count,
        volume_naira:       koboToNaira(r.volume),
        fee_incl_vat_naira: koboToNaira(r.fee_incl_vat),
        output_vat_naira:   koboToNaira(out),
        input_vat_naira:    koboToNaira(inp),
        net_vat_naira:      koboToNaira(out - inp),
      };
    });
    const pv = payoutVat[0] || { cnt: 0, output_vat: 0n };
    if (Number(pv.output_vat) > 0) {
      products.push({
        product: 'PAYOUTS', txn_count: pv.cnt, volume_naira: 0, fee_incl_vat_naira: 0,
        output_vat_naira: koboToNaira(pv.output_vat), input_vat_naira: 0,
        net_vat_naira: koboToNaira(pv.output_vat),
      });
    }
    const totals = products.reduce((t, p) => ({
      output_vat_naira: t.output_vat_naira + p.output_vat_naira,
      input_vat_naira:  t.input_vat_naira  + p.input_vat_naira,
      net_vat_naira:    t.net_vat_naira    + p.net_vat_naira,
      txn_count:        t.txn_count        + p.txn_count,
    }), { output_vat_naira: 0, input_vat_naira: 0, net_vat_naira: 0, txn_count: 0 });

    ok(res, {
      month, vat_rate: '7.5%', products, totals,
      note: 'Net VAT payable = output VAT (on Paylode fees) − input VAT (charged by rails). VAT components are recorded from 2026-06-15.',
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/cbn?month=YYYY-MM — CBN PSSP_RETURNS monthly report ───
// All transactions are WEB (CHNL004) for now. Volume = successful txn count,
// Value = sum of amount (NGN). The dashboard renders the exact PSSP layout to xlsx.
router.get('/cbn', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const now = new Date();
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
      ? req.query.month
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const start = new Date(month + '-01T00:00:00.000Z');
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const [yyyy, mm] = month.split('-');
    const lastDay = new Date(end.getTime() - 1).getUTCDate();
    const period = `01-${String(lastDay).padStart(2, '0')}/${mm}/${yyyy}`;

    const agg = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS volume, COALESCE(SUM(amount),0) AS value_kobo
      FROM transactions
      WHERE status = 'SUCCESS' AND is_sandbox = false
        AND paid_at >= ${start} AND paid_at < ${end}
    `;
    const webVolume = agg[0] ? agg[0].volume : 0;
    const webValue  = agg[0] ? Number(agg[0].value_kobo) / 100 : 0;

    const channels = [
      { code: 'CHNL001', channel: 'ATM',         volume: 0,         value: 0,        period },
      { code: 'CHNL002', channel: 'POS',         volume: 0,         value: 0,        period },
      { code: 'CHNL004', channel: 'WEB',         volume: webVolume, value: webValue, period },
      { code: 'CHNL004', channel: 'USSD',        volume: 0,         value: 0,        period },
      { code: 'CHNL005', channel: 'Mobile App',  volume: 0,         value: 0,        period },
      { code: 'CHNL006', channel: 'Bank Branch', volume: 0,         value: 0,        period },
    ];
    ok(res, {
      month, institution: 'Paylode Services Limited', frequency: 'Monthly',
      frequency_date: `01/${mm}/${yyyy}`, currency: 'NGN', period,
      channels, total_volume: webVolume, total_value: webValue,
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/daily-summary ────────────────────────────────────
router.get('/daily-summary', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0,0,0,0);
    const nextDay = new Date(targetDate); nextDay.setDate(nextDay.getDate() + 1);

    const rows = await prisma.$queryRaw`
      SELECT
        m.business_name,
        m.merchant_code,
        t.channel::text,
        t.status::text,
        COUNT(*)::int              AS txn_count,
        SUM(t.amount)::bigint      AS total_volume,
        SUM(t.merchant_fee)::bigint AS total_fees,
        SUM(t.paylode_margin)::bigint AS paylode_net,
        ROUND(AVG(t.amount))::bigint  AS avg_txn_size
      FROM transactions t
      JOIN merchants m ON t.merchant_id = m.id
      WHERE t.created_at >= ${targetDate}
        AND t.created_at < ${nextDay}
        AND t.is_sandbox = false
      GROUP BY m.business_name, m.merchant_code, t.channel, t.status
      ORDER BY total_volume DESC
    `;

    const totals = await prisma.transaction.aggregate({
      where: { createdAt: { gte: targetDate, lt: nextDay }, isSandbox: false },
      _count: true,
      _sum: { amount: true, merchantFee: true, paylodeMargin: true },
    });

    ok(res, {
      date: targetDate.toISOString().split('T')[0],
      summary: {
        total_transactions: totals._count,
        total_volume_kobo:  Number(totals._sum.amount || 0),
        total_volume_naira: koboToNaira(totals._sum.amount || 0),
        total_fees_kobo:    Number(totals._sum.merchantFee || 0),
        paylode_net_kobo:   Number(totals._sum.paylodeMargin || 0),
      },
      breakdown: rows.map(r => ({
        ...r,
        total_volume_naira: koboToNaira(r.total_volume),
        total_fees_naira:   koboToNaira(r.total_fees),
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/revenue ───────────────────────────────────────────
router.get('/revenue', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { from, to, groupBy='month' } = req.query;
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate   = to ? new Date(to) : new Date();

    const rows = await prisma.$queryRaw`
      SELECT
        DATE_TRUNC(${groupBy}, t.created_at) AS period,
        t.currency                      AS currency,
        m.kyc_tier,
        t.channel::text,
        COUNT(*)::int                   AS txn_count,
        SUM(t.amount)::bigint           AS volume,
        SUM(t.merchant_fee - COALESCE(t.vat_output,0))::bigint AS gross_revenue,
        SUM(t.rail_cost - COALESCE(t.vat_input,0))::bigint     AS rail_costs,
        SUM(t.net_revenue)::bigint      AS net_after_rails,
        SUM(t.agg_share)::bigint        AS agg_payouts,
        SUM(t.paylode_margin)::bigint   AS paylode_margin,
        SUM(COALESCE(t.vat_output,0) - COALESCE(t.vat_input,0))::bigint AS net_vat,
        ROUND(
          SUM(t.paylode_margin) * 100.0 / NULLIF(SUM(t.merchant_fee - COALESCE(t.vat_output,0)),0), 2
        )                               AS margin_pct
      FROM transactions t
      JOIN merchants m ON t.merchant_id = m.id
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.created_at BETWEEN ${fromDate} AND ${toDate}
      GROUP BY period, t.currency, m.kyc_tier, t.channel
      ORDER BY period DESC, paylode_margin DESC
    `;

    const mapRow = r => {
      const ccy = r.currency || 'NGN';
      return {
        period:           r.period,
        currency:         ccy,
        is_international: ccy === 'USD',
        kyc_tier:         r.kyc_tier,
        channel:          r.channel,
        product:          (r.channel === 'CARD') ? (ccy === 'USD' ? 'International Card' : 'Local Card') : r.channel,
        txn_count:        r.txn_count,
        volume_major:     Number(r.volume) / 100,
        gross_revenue:    Number(r.gross_revenue) / 100,
        rail_costs:       Number(r.rail_costs) / 100,
        net_after_rails:  Number(r.net_after_rails) / 100,
        agg_payouts:      Number(r.agg_payouts) / 100,
        paylode_margin:   Number(r.paylode_margin) / 100,
        net_vat:          Number(r.net_vat || 0) / 100,
        margin_pct:       Number(r.margin_pct || 0),
        // legacy naira keys
        volume_naira:     koboToNaira(r.volume),
      };
    };
    // Payouts: gross revenue = our fee (EX-VAT); rail cost = rail fee (EX-VAT) summed
    // per item via correlated subquery (avoids double-counting retry legs); margin =
    // gross − rail; net VAT = our output VAT − rail input VAT. Consistent w/ txn rows.
    const payoutRows = await prisma.$queryRaw`
      SELECT DATE_TRUNC(${groupBy}, pi.created_at) AS period, 'NGN' AS currency, m.kyc_tier,
             'PAYOUT'::text AS channel, COUNT(*)::int AS txn_count,
             SUM(pi.amount)::bigint AS volume,
             SUM(pi.item_fee)::bigint AS gross_revenue,
             SUM(COALESCE((SELECT SUM(rd.rail_fee) FROM rail_disbursements rd WHERE rd.payout_item_id = pi.id AND rd.status='success'),0))::bigint AS rail_costs,
             (SUM(pi.item_fee) - SUM(COALESCE((SELECT SUM(rd.rail_fee) FROM rail_disbursements rd WHERE rd.payout_item_id = pi.id AND rd.status='success'),0)))::bigint AS net_after_rails,
             0::bigint AS agg_payouts,
             (SUM(pi.item_fee) - SUM(COALESCE((SELECT SUM(rd.rail_fee) FROM rail_disbursements rd WHERE rd.payout_item_id = pi.id AND rd.status='success'),0)))::bigint AS paylode_margin,
             (SUM(COALESCE(pi.item_vat,0)) - SUM(COALESCE((SELECT SUM(rd.rail_vat) FROM rail_disbursements rd WHERE rd.payout_item_id = pi.id AND rd.status='success'),0)))::bigint AS net_vat,
             ROUND( (SUM(pi.item_fee) - SUM(COALESCE((SELECT SUM(rd.rail_fee) FROM rail_disbursements rd WHERE rd.payout_item_id = pi.id AND rd.status='success'),0))) * 100.0 / NULLIF(SUM(pi.item_fee),0), 2) AS margin_pct
      FROM payout_items pi
      JOIN payout_batches pb ON pi.batch_id = pb.id
      JOIN merchants m       ON pi.merchant_id = m.id
      WHERE pi.status = 'success' AND pi.created_at BETWEEN ${fromDate} AND ${toDate}
      GROUP BY period, m.kyc_tier
    `;
    const all = rows.concat(payoutRows).map(mapRow);

    ok(res, {
      period: { from: fromDate, to: toDate, group_by: groupBy },
      data:     all.filter(r => r.currency === 'NGN'),  // legacy: NGN-only
      data_ngn: all.filter(r => r.currency === 'NGN'),
      data_usd: all.filter(r => r.currency === 'USD'),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/aggregator-revenue ────────────────────────────────
router.get('/aggregator-revenue', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { month } = req.query;
    const periodStart = month ? new Date(month + '-01') : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const periodEnd   = new Date(periodStart); periodEnd.setMonth(periodEnd.getMonth()+1);

    const rows = await prisma.$queryRaw`
      SELECT
        a.id AS aggregator_id,
        a.company_name,
        a.revenue_split_pct,
        COUNT(DISTINCT m.id)::int       AS merchant_count,
        COUNT(t.id)::int                AS txn_count,
        SUM(t.amount)::bigint           AS total_volume,
        SUM(t.merchant_fee)::bigint     AS gross_fees,
        SUM(t.rail_cost)::bigint        AS rail_deductions,
        SUM(t.net_revenue)::bigint      AS net_pool,
        SUM(t.agg_share)::bigint        AS agg_payout_due,
        SUM(t.paylode_margin)::bigint   AS paylode_keeps
      FROM aggregators a
      JOIN merchants m  ON m.aggregator_id = a.id
      JOIN transactions t ON t.merchant_id = m.id
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.created_at >= ${periodStart}
        AND t.created_at < ${periodEnd}
      GROUP BY a.id, a.company_name, a.revenue_split_pct
      ORDER BY agg_payout_due DESC
    `;

    ok(res, {
      period: { month: periodStart.toISOString().split('T')[0].slice(0,7) },
      data: rows.map(r => ({
        aggregator_id:   r.aggregator_id,
        company_name:    r.company_name,
        split_pct:       Number(r.revenue_split_pct) * 100 + '%',
        merchant_count:  r.merchant_count,
        txn_count:       r.txn_count,
        total_volume:    koboToNaira(r.total_volume),
        gross_fees:      koboToNaira(r.gross_fees),
        rail_deductions: koboToNaira(r.rail_deductions),
        net_pool:        koboToNaira(r.net_pool),
        agg_payout_due:  koboToNaira(r.agg_payout_due),
        paylode_keeps:   koboToNaira(r.paylode_keeps),
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/rail-cost-analysis ────────────────────────────────
router.get('/rail-cost-analysis', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        pr.name AS rail_name,
        t.channel::text,
        COUNT(*)::int                    AS txn_count,
        SUM(t.amount)::bigint            AS volume,
        SUM(t.merchant_fee)::bigint      AS fees_earned,
        SUM(t.rail_cost)::bigint         AS rail_cost_paid,
        SUM(t.net_revenue)::bigint       AS net_contribution,
        ROUND(
          SUM(t.rail_cost)*100.0 / NULLIF(SUM(t.merchant_fee),0), 2
        )                                AS cost_as_pct_revenue
      FROM transactions t
      JOIN payment_rails pr ON t.rail_id = pr.id
      WHERE t.status = 'SUCCESS' AND t.is_sandbox = false
        AND t.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY pr.name, t.channel
      ORDER BY net_contribution DESC
    `;

    ok(res, rows.map(r => ({
      rail:              r.rail_name,
      channel:           r.channel,
      txn_count:         r.txn_count,
      volume:            koboToNaira(r.volume),
      fees_earned:       koboToNaira(r.fees_earned),
      rail_cost_paid:    koboToNaira(r.rail_cost_paid),
      net_contribution:  koboToNaira(r.net_contribution),
      cost_pct_revenue:  Number(r.cost_as_pct_revenue || 0),
    })));
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/kyc-pipeline ─────────────────────────────────────
router.get('/kyc-pipeline', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        k.tier_applied,
        k.status,
        COUNT(*)::int    AS count,
        ROUND(AVG(
          EXTRACT(EPOCH FROM COALESCE(k.approved_at, NOW()) - k.submitted_at) / 3600
        ), 1)::float     AS avg_hours_to_decision,
        k.rejection_code
      FROM kyc_submissions k
      WHERE k.submitted_at >= NOW() - INTERVAL '90 days'
      GROUP BY k.tier_applied, k.status, k.rejection_code
      ORDER BY k.tier_applied, k.status
    `;

    const pending = await prisma.kycSubmission.count({ where: { status: { in: ['submitted','in_review'] } } });

    ok(res, { pending_review: pending, breakdown: rows });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/failure-analysis ─────────────────────────────────
router.get('/failure-analysis', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        pr.name                          AS rail,
        t.channel::text,
        t.failure_reason,
        COUNT(*)::int                    AS failed_count,
        ROUND(COUNT(*) * 100.0 /
          SUM(COUNT(*)) OVER (PARTITION BY pr.name, t.channel), 2) AS failure_rate_pct
      FROM transactions t
      LEFT JOIN payment_rails pr ON t.rail_id = pr.id
      WHERE t.status = 'FAILED'
        AND t.is_sandbox = false
        AND t.created_at >= NOW() - INTERVAL '7 days'
      GROUP BY pr.name, t.channel, t.failure_reason
      ORDER BY failed_count DESC
    `;

    ok(res, rows);
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/merchant-statement ─────────────────────────────────
// Merchant can pull their own; admin can pull any
router.get('/merchant-statement', requireAuth, async (req, res, next) => {
  try {
    const { merchant_id, from, to, page=1, perPage=100 } = req.query;
    let targetMerchantId;

    if (req.user.role === 'MERCHANT') {
      targetMerchantId = req.user.merchant?.id;
      if (!targetMerchantId) return fail(res, 'No merchant account');
    } else {
      if (!merchant_id) return fail(res, 'merchant_id required');
      targetMerchantId = merchant_id;
    }

    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate   = to ? new Date(to + 'T23:59:59Z') : new Date();

    const [txns, byCcy] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          merchantId: targetMerchantId,
          isSandbox: false,
          createdAt: { gte: fromDate, lte: toDate },
        },
        skip:    (parseInt(page)-1)*parseInt(perPage),
        take:    parseInt(perPage),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.transaction.groupBy({
        by: ['currency'],
        where: { merchantId: targetMerchantId, isSandbox: false, status: 'SUCCESS', createdAt: { gte: fromDate, lte: toDate } },
        _count: true,
        _sum: { amount: true, merchantFee: true },
      }),
    ]);

    const merchant = await prisma.merchant.findUnique({ where: { id: targetMerchantId }, select: { businessName:true, merchantCode:true } });

    // Per-currency summary blocks (always include NGN + USD)
    const blank = () => ({ successful_transactions:0, total_collections:0, total_fees_paid:0, net_settled:0 });
    const summaryBy = { NGN: blank(), USD: blank() };
    byCcy.forEach(g => {
      const c = g.currency === 'USD' ? 'USD' : 'NGN';
      summaryBy[c] = {
        successful_transactions: g._count,
        total_collections:       Number(g._sum.amount || 0) / 100,
        total_fees_paid:         Number(g._sum.merchantFee || 0) / 100,
        net_settled:             Number((g._sum.amount || 0n) - (g._sum.merchantFee || 0n)) / 100,
      };
    });

    ok(res, {
      merchant,
      period:    { from: fromDate, to: toDate },
      // legacy NGN-only summary (kept for existing callers)
      summary: summaryBy.NGN,
      summary_by_currency: summaryBy,
      transactions: txns.map(t => ({
        reference:       t.reference,
        date:            t.createdAt,
        customer_email:  t.customerEmail,
        currency:        t.currency || 'NGN',
        is_international: t.currency === 'USD',
        amount:          Number(t.amount) / 100,
        channel:         t.channel,
        status:          t.status,
        fee:             Number(t.merchantFee) / 100,
        net:             Number(t.amount - t.merchantFee) / 100,
        failure_reason:  t.failureReason,
        metadata:        t.metadata,
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/settlement-reconciliation ──────────────────────────
router.get('/settlement-reconciliation', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const date = req.query.date ? new Date(req.query.date) : new Date();
    date.setHours(0,0,0,0);
    const nextDay = new Date(date); nextDay.setDate(nextDay.getDate()+1);

    const rows = await prisma.$queryRaw`
      SELECT
        m.business_name,
        m.merchant_code,
        m.settlement_bank,
        SUM(t.amount)::bigint           AS gross_collections,
        SUM(t.merchant_fee)::bigint     AS fees,
        SUM(t.amount - t.merchant_fee)::bigint AS net_to_settle,
        s.net_settled::bigint           AS actually_settled,
        s.status                        AS settlement_status
      FROM transactions t
      JOIN merchants m ON t.merchant_id = m.id
      LEFT JOIN settlements s
        ON s.merchant_id = m.id
        AND s.period_end = ${date}::date
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.created_at >= ${date}
        AND t.created_at < ${nextDay}
      GROUP BY m.business_name, m.merchant_code, m.settlement_bank,
               s.net_settled, s.status
    `;

    ok(res, {
      date: date.toISOString().split('T')[0],
      merchants: rows.map(r => ({
        ...r,
        gross_collections_naira: koboToNaira(r.gross_collections),
        fees_naira:              koboToNaira(r.fees),
        net_to_settle_naira:     koboToNaira(r.net_to_settle),
        actually_settled_naira:  r.actually_settled ? koboToNaira(r.actually_settled) : null,
        discrepancy:             r.actually_settled ? Number(r.net_to_settle - r.actually_settled) : null,
      })),
    });
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/aml-flags ─────────────────────────────────────────
router.get('/aml-flags', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status, riskLevel, page=1, perPage=50 } = req.query;
    const where = {};
    if (status)    where.status    = status.toUpperCase();
    if (riskLevel) where.riskLevel = riskLevel.toUpperCase();
    else where.status = { not: 'CLOSED' };

    const flags = await prisma.amlFlag.findMany({
      where,
      skip:    (parseInt(page)-1)*parseInt(perPage),
      take:    parseInt(perPage),
      orderBy: [{ riskLevel: 'desc' }, { createdAt: 'asc' }],
      include: {
        merchant:    { select: { businessName:true, merchantCode:true, kycTier:true } },
        transaction: { select: { reference:true, amount:true, channel:true } },
      },
    });

    ok(res, flags.map(f => ({
      id:          f.id,
      flag_type:   f.flagType,
      risk_level:  f.riskLevel,
      status:      f.status,
      merchant:    f.merchant,
      transaction: f.transaction ? {
        reference: f.transaction.reference,
        amount:    koboToNaira(f.transaction.amount),
        channel:   f.transaction.channel,
      } : null,
      description: f.description,
      created_at:  f.createdAt,
      open_hours:  Math.round((Date.now() - new Date(f.createdAt).getTime()) / 3600000),
    })));
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/cbn-monthly ──────────────────────────────────────
router.get('/cbn-monthly', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { month } = req.query;
    const start = month ? new Date(month + '-01') : new Date(new Date().getFullYear(), new Date().getMonth()-1, 1);
    const end   = new Date(start); end.setMonth(end.getMonth()+1);

    const [txnRows, kycRows, merchantCount, amlCount] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          t.channel::text,
          COUNT(*)::int                                                AS total,
          COUNT(*) FILTER (WHERE t.status='SUCCESS')::int             AS successful,
          COUNT(*) FILTER (WHERE t.status='FAILED')::int              AS failed,
          SUM(t.amount) FILTER (WHERE t.status='SUCCESS')::bigint     AS successful_value,
          COUNT(DISTINCT t.merchant_id)::int                          AS active_merchants
        FROM transactions t
        WHERE t.created_at >= ${start} AND t.created_at < ${end}
          AND t.is_sandbox = false
        GROUP BY t.channel
      `,
      prisma.kycSubmission.groupBy({
        by: ['status', 'tierApplied'],
        _count: true,
        where: { submittedAt: { gte: start, lt: end } },
      }),
      prisma.merchant.count({ where: { isActive: true } }),
      prisma.amlFlag.count({ where: { status: 'REPORTED_TO_CBN', createdAt: { gte: start, lt: end } } }),
    ]);

    ok(res, {
      report_type:  'CBN PSSP Monthly Return',
      license_no:   process.env.CBN_LICENSE_NO,
      period:       { from: start, to: end },
      generated_at: new Date(),
      transaction_summary: txnRows.map(r => ({
        channel:         r.channel,
        total:           r.total,
        successful:      r.successful,
        failed:          r.failed,
        successful_value:koboToNaira(r.successful_value || 0),
        active_merchants:r.active_merchants,
      })),
      kyc_summary:    kycRows,
      total_active_merchants: merchantCount,
      strs_filed:     amlCount,
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/reports/statement-email ─────────────────────────────────────
// Email a merchant statement to the logged-in user's email.
router.post('/statement-email', requireAuth, async (req, res, next) => {
  try {
    const { from, to } = req.body;
    let targetMerchantId;

    if (req.user.role === 'MERCHANT') {
      targetMerchantId = req.user.merchant?.id;
      if (!targetMerchantId) return fail(res, 'No merchant account');
    } else {
      return fail(res, 'Only merchant users can email their own statement');
    }

    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate   = to   ? new Date(to + 'T23:59:59Z') : new Date();

    const [merchant, totals, txns] = await Promise.all([
      prisma.merchant.findUnique({ where:{ id: targetMerchantId }, select:{ businessName:true, merchantCode:true, user:{ select:{ email:true }} } }),
      prisma.transaction.aggregate({
        where:{ merchantId: targetMerchantId, isSandbox: false, status: 'SUCCESS', createdAt:{ gte: fromDate, lte: toDate } },
        _count: true, _sum:{ amount: true, merchantFee: true },
      }),
      prisma.transaction.findMany({
        where:{ merchantId: targetMerchantId, isSandbox: false, createdAt:{ gte: fromDate, lte: toDate } },
        orderBy:{ createdAt: 'desc' }, take: 200,
      }),
    ]);

    const recipientEmail = req.user.email || merchant?.user?.email;
    if (!recipientEmail) return fail(res, 'Could not determine recipient email');

    const fmt = (kobo) => new Intl.NumberFormat('en-NG',{ style:'currency', currency:'NGN', minimumFractionDigits:2 }).format(Number(kobo||0)/100);
    const rows = txns.map(t => `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px 12px;font-family:monospace;font-size:11px">${t.reference}</td>
      <td style="padding:8px 12px;font-size:12px">${new Date(t.createdAt).toLocaleDateString('en-NG')}</td>
      <td style="padding:8px 12px">${t.channel}</td>
      <td style="padding:8px 12px;font-weight:600">${fmt(t.amount)}</td>
      <td style="padding:8px 12px;color:#ef4444">${fmt(t.merchantFee)}</td>
      <td style="padding:8px 12px;font-weight:700;color:#10b981">${fmt(t.amount - t.merchantFee)}</td>
      <td style="padding:8px 12px"><span style="background:${t.status==='SUCCESS'?'#d1fae5':t.status==='FAILED'?'#fee2e2':'#fef3c7'};color:${t.status==='SUCCESS'?'#065f46':t.status==='FAILED'?'#991b1b':'#92400e'};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${t.status}</span></td>
    </tr>`).join('');

    const html = `
    <div style="font-family:'DM Sans',Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#1a2744;padding:24px;border-radius:12px 12px 0 0">
        <div style="color:#7dc534;font-size:20px;font-weight:700">Paylode Services Limited</div>
        <div style="color:rgba(255,255,255,.6);font-size:12px">CBN Licensed PSSP · Account Statement</div>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e2e8f0;border-top:none">
        <h2 style="margin:0 0 4px;font-size:18px;color:#1a2744">Transaction Statement</h2>
        <div style="font-size:13px;color:#64748b;margin-bottom:20px">
          ${merchant?.businessName} · ${merchant?.merchantCode}<br>
          Period: ${fromDate.toLocaleDateString('en-NG')} – ${toDate.toLocaleDateString('en-NG')}
        </div>
        <div style="display:flex;gap:16px;margin-bottom:24px">
          <div style="flex:1;background:#f8fafc;border-radius:8px;padding:16px">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Total Collections</div>
            <div style="font-size:20px;font-weight:700;color:#1a2744">${fmt(totals._sum.amount)}</div>
          </div>
          <div style="flex:1;background:#f8fafc;border-radius:8px;padding:16px">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Fees Paid</div>
            <div style="font-size:20px;font-weight:700;color:#ef4444">${fmt(totals._sum.merchantFee)}</div>
          </div>
          <div style="flex:1;background:#f0fdf4;border-radius:8px;padding:16px;border:1px solid #bbf7d0">
            <div style="font-size:11px;color:#065f46;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Net Settled</div>
            <div style="font-size:20px;font-weight:700;color:#10b981">${fmt((totals._sum.amount||0n)-(totals._sum.merchantFee||0n))}</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Reference</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Date</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Channel</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Amount</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Fee</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Net</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Status</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#94a3b8">No transactions in this period</td></tr>'}</tbody>
        </table>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">
          This statement was auto-generated by Paylode Services Limited<br>
          For queries: support@paylodeservices.com
        </div>
      </div>
    </div>`;

    const mailer = getMailer();
    await mailer.sendMail({
      from:    `"Paylode Services" <${process.env.SMTP_USER}>`,
      to:      recipientEmail,
      subject: `Your Paylode Statement — ${merchant?.businessName} (${fromDate.toLocaleDateString('en-NG')} to ${toDate.toLocaleDateString('en-NG')})`,
      html,
    });

    ok(res, { sent_to: recipientEmail }, 'Statement emailed successfully');
  } catch (e) { next(e); }
});

// ── GET /api/v1/reports/rail-settlement ───────────────────────────────────────
// Settlement breakdown grouped by RAIL and PRODUCT (channel). Super admin / compliance.
router.get('/rail-settlement', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const toDate   = to   ? new Date(to + 'T23:59:59Z') : new Date();

    // Per rail + product + CURRENCY breakdown (successful, non-sandbox)
    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE(pr.name, 'Unrouted / Pending') AS rail_name,
        pr.status                               AS rail_status,
        t.currency                              AS currency,
        t.channel::text                         AS channel,
        COUNT(*)::int                           AS txn_count,
        SUM(t.amount)::bigint                    AS volume,
        SUM(t.merchant_fee - COALESCE(t.vat_output,0))::bigint AS fee_revenue,
        SUM(t.rail_cost - COALESCE(t.vat_input,0))::bigint     AS rail_cost,
        SUM(t.paylode_margin)::bigint           AS paylode_margin
      FROM transactions t
      LEFT JOIN payment_rails pr ON t.rail_id = pr.id
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.created_at >= ${fromDate}
        AND t.created_at <= ${toDate}
      GROUP BY pr.name, pr.status, t.currency, t.channel
      ORDER BY t.currency, pr.name NULLS LAST, t.channel
    `;

    // Per-rail + currency rollup
    const railTotals = await prisma.$queryRaw`
      SELECT
        COALESCE(pr.name, 'Unrouted / Pending') AS rail_name,
        t.currency                              AS currency,
        COUNT(*)::int                           AS txn_count,
        SUM(t.amount)::bigint                    AS volume,
        SUM(t.merchant_fee - COALESCE(t.vat_output,0))::bigint AS fee_revenue,
        SUM(t.rail_cost - COALESCE(t.vat_input,0))::bigint     AS rail_cost,
        SUM(t.paylode_margin)::bigint           AS paylode_margin
      FROM transactions t
      LEFT JOIN payment_rails pr ON t.rail_id = pr.id
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.created_at >= ${fromDate}
        AND t.created_at <= ${toDate}
      GROUP BY pr.name, t.currency
      ORDER BY t.currency, SUM(t.amount) DESC NULLS LAST
    `;

    const productName = (channel, ccy) =>
      channel === 'CARD' ? (ccy === 'USD' ? 'International Card (USD)' : 'Local Card') :
      channel === 'BANK_TRANSFER' ? 'Virtual Account' : channel;

    const ser = r => {
      const ccy = r.currency || 'NGN';
      return {
        rail_name:    r.rail_name,
        rail_status:  r.rail_status || null,
        currency:     ccy,
        product:      r.channel ? productName(r.channel, ccy) : null,
        channel:      r.channel || null,
        txn_count:    Number(r.txn_count || 0),
        volume_major: Number(r.volume || 0) / 100,
        fee_revenue_major: Number(r.fee_revenue || 0) / 100,
        rail_cost_major:   Number(r.rail_cost || 0) / 100,
        margin_major:      Number(r.paylode_margin || 0) / 100,
      };
    };

    const totalsFor = (ccy) => {
      const f = rows.filter(r => (r.currency || 'NGN') === ccy);
      return {
        txn_count:         f.reduce((s, r) => s + Number(r.txn_count || 0), 0),
        volume_major:      f.reduce((s, r) => s + Number(r.volume || 0), 0) / 100,
        fee_revenue_major: f.reduce((s, r) => s + Number(r.fee_revenue || 0), 0) / 100,
        rail_cost_major:   f.reduce((s, r) => s + Number(r.rail_cost || 0), 0) / 100,
        margin_major:      f.reduce((s, r) => s + Number(r.paylode_margin || 0), 0) / 100,
      };
    };

    // ── International card breakdown by SCHEME (Visa/Mastercard/Amex/Diners) ──────
    // Scheme is stored on the transaction's metadata (set at init / charge).
    const schemeRows = await prisma.$queryRaw`
      SELECT
        COALESCE(NULLIF(t.metadata->>'card_scheme', ''), 'UNSPECIFIED') AS scheme,
        COUNT(*)::int                  AS txn_count,
        SUM(t.amount)::bigint          AS volume,
        SUM(t.merchant_fee)::bigint    AS fee_revenue,
        SUM(t.paylode_margin)::bigint  AS paylode_margin
      FROM transactions t
      WHERE t.status = 'SUCCESS'
        AND t.is_sandbox = false
        AND t.currency = 'USD'
        AND t.channel = 'CARD'
        AND t.created_at >= ${fromDate}
        AND t.created_at <= ${toDate}
      GROUP BY 1
      ORDER BY SUM(t.amount) DESC NULLS LAST
    `;
    const schemeLabel = { VISA:'Visa', MASTERCARD:'Mastercard', AMEX:'American Express', DINERS:'Diners Club', UNSPECIFIED:'Unspecified / Flat' };
    const byScheme = schemeRows.map(r => ({
      scheme:            r.scheme,
      scheme_label:      schemeLabel[r.scheme] || r.scheme,
      currency:          'USD',
      txn_count:         Number(r.txn_count || 0),
      volume_major:      Number(r.volume || 0) / 100,
      fee_revenue_major: Number(r.fee_revenue || 0) / 100,
      margin_major:      Number(r.paylode_margin || 0) / 100,
    }));

    ok(res, {
      period: { from: fromDate, to: toDate },
      by_rail_product: rows.map(ser),
      by_rail:         railTotals.map(ser),
      by_scheme:       byScheme,  // international (USD) cards split by card scheme
      totals_by_currency: { NGN: totalsFor('NGN'), USD: totalsFor('USD') },
    });
  } catch (e) { next(e); }
});

// ── POST /api/v1/reports/email — email a generated report as an attachment ───
// The client builds the file (CSV/Excel) and posts it base64; we email it.
// Any logged-in user (incl. merchants) can email a report to themselves; staff
// may specify another recipient. Works for EVERY report (download → email).
const { sendEmail } = require('../../../services/emailService');
const { logAudit }  = require('../../../services/auditService');
router.post('/email', requireAuth, async (req, res, next) => {
  try {
    const { filename, content_base64, mime, subject, to } = req.body;
    if (!filename || !content_base64) return fail(res, 'filename and content_base64 are required');
    if (String(content_base64).length > 14_000_000) return fail(res, 'Report too large to email (max ~10MB)');
    const staff = ['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT'].includes(req.user.role);
    const recipient = (staff && to) ? to : req.user.email;
    if (!recipient) return fail(res, 'No email address on your account');
    await sendEmail({
      to: recipient,
      subject: subject || ('Your Paylode report — ' + filename),
      html: `<p>Hi,</p><p>Your requested report <strong>${filename}</strong> is attached.</p><p>— Paylode</p>`,
      attachments: [{ filename, content: Buffer.from(content_base64, 'base64'), contentType: mime || 'application/octet-stream' }],
    });
    logAudit(req.user.id, 'REPORT_EMAILED', 'reports', req.user.id, null, { filename, to: recipient }).catch(() => {});
    ok(res, { sent: true, to: recipient }, 'Report emailed to ' + recipient);
  } catch (e) { next(e); }
});

module.exports = router;
