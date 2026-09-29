'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireRole, requirePermission } = require('../middleware/auth');
const { ok, koboToNaira } = require('../utils/helpers');

// Activity-log actor classification.
const STAFF_ROLES    = ['SUPER_ADMIN', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDIT'];
const CUSTOMER_ROLES = ['MERCHANT', 'AGGREGATOR'];

router.get('/dashboard', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

    // Group by currency so NGN (local) and USD (international cards) stay separate.
    // Payout items (payout_batches/payout_items) are separate from transactions but
    // contribute to platform volume, fees earned, and Paylode margin.
    const [todayGroups, mtdGroups, merchantCount, aggCount, kycPending,
           todayPayouts, mtdPayouts] = await Promise.all([
      prisma.transaction.groupBy({ by:['currency'], where:{createdAt:{gte:today},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.transaction.groupBy({ by:['currency'], where:{createdAt:{gte:monthStart},isSandbox:false,status:'SUCCESS'}, _count:true, _sum:{amount:true,merchantFee:true,paylodeMargin:true} }),
      prisma.merchant.count({ where:{isActive:true} }),
      prisma.aggregator.count({ where:{status:'active'} }),
      prisma.kycSubmission.count({ where:{status:{in:['submitted','in_review']}} }),
      // Payout totals: volume + fee charged to merchant + Paylode margin (fee − rail cost)
      prisma.$queryRaw`
        SELECT COALESCE(SUM(pi.amount),0)::bigint    AS volume,
               COALESCE(SUM(pi.item_fee),0)::bigint  AS fees,
               COALESCE(SUM(pi.item_fee),0)::bigint - COALESCE(SUM(rd.rail_fee_sum),0)::bigint AS paylode_net,
               COUNT(*)::int                          AS txn_count
        FROM payout_items pi
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(rail_fee),0) AS rail_fee_sum
          FROM rail_disbursements WHERE payout_item_id = pi.id AND status = 'success'
        ) rd ON true
        WHERE pi.status = 'success' AND pi.created_at >= ${today}`,
      prisma.$queryRaw`
        SELECT COALESCE(SUM(pi.amount),0)::bigint    AS volume,
               COALESCE(SUM(pi.item_fee),0)::bigint  AS fees,
               COALESCE(SUM(pi.item_fee),0)::bigint - COALESCE(SUM(rd.rail_fee_sum),0)::bigint AS paylode_net,
               COUNT(*)::int                          AS txn_count
        FROM payout_items pi
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(rail_fee),0) AS rail_fee_sum
          FROM rail_disbursements WHERE payout_item_id = pi.id AND status = 'success'
        ) rd ON true
        WHERE pi.status = 'success' AND pi.created_at >= ${monthStart}`,
    ]);

    // Always return both NGN and USD blocks (USD shows zeros until intl cards transact).
    const blankCcy = () => ({ txn_count:0, volume:0, fees:0, paylode_net:0 });
    const shape = (groups, payoutRow) => {
      const out = { NGN: blankCcy(), USD: blankCcy() };
      groups.forEach(g => {
        const c = (g.currency === 'USD') ? 'USD' : 'NGN';
        out[c] = {
          txn_count:   g._count,
          volume:      Number(g._sum.amount||0)/100,
          fees:        Number(g._sum.merchantFee||0)/100,
          paylode_net: Number(g._sum.paylodeMargin||0)/100,
        };
      });
      // Fold in payout activity (always NGN)
      if (payoutRow) {
        const p = payoutRow[0] || {};
        out.NGN.txn_count   += Number(p.txn_count   || 0);
        out.NGN.volume      += Number(p.volume      || 0) / 100;
        out.NGN.fees        += Number(p.fees        || 0) / 100;
        out.NGN.paylode_net += Number(p.paylode_net || 0) / 100;
      }
      return out;
    };

    const todayBy = shape(todayGroups, todayPayouts);
    const mtdBy   = shape(mtdGroups,   mtdPayouts);

    ok(res, {
      // by_currency blocks (new — separated)
      today_by_currency: todayBy,
      mtd_by_currency:   mtdBy,
      // legacy NGN-only keys kept so existing UI keeps working
      today: { txn_count:todayBy.NGN.txn_count, volume:todayBy.NGN.volume, fees:todayBy.NGN.fees, paylode_net:todayBy.NGN.paylode_net },
      mtd:   { txn_count:mtdBy.NGN.txn_count,   volume:mtdBy.NGN.volume,   fees:mtdBy.NGN.fees,   paylode_net:mtdBy.NGN.paylode_net },
      active_merchants: merchantCount,
      active_aggregators: aggCount,
      kyc_pending: kycPending,
    });
  } catch(e){next(e);}
});

// ── RAIL BALANCES — SA-only, 4-minute server-side cache ─────────────────────
let _railBalCache = null;
let _railBalCachedAt = 0;
const RAIL_BAL_TTL = 4 * 60 * 1000;

router.get('/rail-balances', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const force = req.query.force === '1';
    const age   = Date.now() - _railBalCachedAt;
    if (!force && _railBalCache && age < RAIL_BAL_TTL)
      return ok(res, { ..._railBalCache, cached: true, age_s: Math.round(age / 1000) });

    const tptSvc = require('../modules/gateway-core/services/parallexTransferService');
    const ppSvc  = require('../modules/gateway-core/services/palmpayService');

    const [tptR, ppR] = await Promise.allSettled([
      tptSvc.getBalance(),
      ppSvc.getBalance(),
    ]);

    const entry = (label, r) => ({
      label,
      balance_naira: r.status === 'fulfilled' ? Number(r.value) / 100 : null,
      error: r.status === 'rejected' ? (r.reason.message || 'query failed').split('\n')[0].replace(/Bearer\s+\S+/gi, '[token]').replace(/Ocp-Apim[^:]*:\s*\S+/gi, '[key]').slice(0, 120) : null,
    });

    const data = {
      balances: [
        entry('Parallex — TPT Payout Float', tptR),
        entry('PalmPay', ppR),
      ],
      fetched_at: new Date().toISOString(),
    };

    _railBalCache = data;
    _railBalCachedAt = Date.now();
    ok(res, { ...data, cached: false, age_s: 0 });
  } catch(e) { next(e); }
});

// Activity log — permission-gated (view_audit_log) so SA can grant it to any role
// (AUDIT has it by default; SA bypasses). Staff vs customer split by actor role,
// plus action / entity / actor / date-range / free-text filters.
router.get('/audit-log', requireAuth, requirePermission('view_audit_log'), async (req,res,next) => {
  try {
    const { page=1, perPage=50, action, actorType, actorId, entityType, role, from, to, q } = req.query;
    const where = {};
    if (action)     where.action     = action;
    if (entityType) where.entityType = entityType;
    if (actorId)    where.actorId    = actorId;
    if (actorType === 'staff')    where.actor = { role: { in: STAFF_ROLES } };
    if (actorType === 'customer') where.actor = { role: { in: CUSTOMER_ROLES } };
    if (role)       where.actor = { role };   // specific-role filter (overrides the tab scope)
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to)   { const t = new Date(to); t.setHours(23,59,59,999); where.createdAt.lte = t; }
    }
    if (q) where.OR = [
      { action:     { contains: q, mode: 'insensitive' } },
      { entityType: { contains: q, mode: 'insensitive' } },
      { notes:      { contains: q, mode: 'insensitive' } },
      { actor: { email: { contains: q, mode: 'insensitive' } } },
    ];

    const [logs, total, actionRows] = await Promise.all([
      prisma.auditLog.findMany({ where, skip:(parseInt(page)-1)*parseInt(perPage), take:parseInt(perPage), orderBy:{createdAt:'desc'}, include:{actor:{select:{email:true,firstName:true,lastName:true,role:true}}} }),
      prisma.auditLog.count({ where }),
      prisma.$queryRaw`SELECT DISTINCT action FROM audit_log ORDER BY action`,
    ]);
    // id is BigInt — must be stringified for JSON.
    const data = logs.map(l => ({
      id: String(l.id), action: l.action, entity_type: l.entityType, entity_id: l.entityId,
      before: l.beforeState, after: l.afterState, notes: l.notes, ip: l.ipAddress,
      created_at: l.createdAt,
      actor: l.actor ? {
        email: l.actor.email,
        name: [l.actor.firstName, l.actor.lastName].filter(Boolean).join(' ') || l.actor.email,
        role: l.actor.role,
        is_staff: STAFF_ROLES.includes(l.actor.role),
      } : null,
    }));
    ok(res, { data, meta:{total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage)), actions: actionRows.map(a=>a.action)} });
  } catch(e){next(e);}
});

// GET /admin/payout-review — items needing SA attention (held or failed/pending_review)
router.get('/payout-review', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [rows, watchRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT pi.id::text, pi.amount::bigint, pi.item_fee::bigint AS "itemFee",
               pi.status, pi.refund_status AS "refundStatus",
               pi.failure_reason AS "failureReason",
               pi.refund_amount::bigint AS "refundAmount",
               pi.created_at AS "createdAt",
               pi.account_number AS "accountNumber", pi.account_name AS "accountName",
               pi.bank_code AS "bankCode", pi.bank_name AS "bankName",
               m.business_name AS "businessName", m.merchant_code AS "merchantCode",
               rd.rail_order_id AS "railOrderId", rd.status AS "railStatus",
               pr.name AS "railName"
        FROM payout_items pi
        JOIN payout_batches pb ON pb.id = pi.batch_id
        JOIN merchants m ON m.id = pi.merchant_id
        LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
        LEFT JOIN payment_rails pr ON pr.id = rd.rail_id
        WHERE pi.status = 'held'
           OR (pi.status = 'failed' AND pi.refund_status = 'pending_review')
           OR (pi.status = 'failed' AND pi.refund_status IS NULL AND pi.failure_reason IS NOT NULL)
        ORDER BY pi.created_at DESC
        LIMIT 200
      `,
      // Watch list: old items where wallet was already refunded (approved) but Parallex
      // couldn't be reached — status still unknown; monitor until Parallex gives a final answer.
      prisma.$queryRaw`
        SELECT pi.id::text, pi.amount::bigint, pi.item_fee::bigint AS "itemFee",
               pi.status, pi.refund_status AS "refundStatus",
               pi.failure_reason AS "failureReason",
               pi.refund_amount::bigint AS "refundAmount",
               pi.created_at AS "createdAt",
               pi.account_number AS "accountNumber", pi.account_name AS "accountName",
               pi.bank_code AS "bankCode", pi.bank_name AS "bankName",
               m.business_name AS "businessName", m.merchant_code AS "merchantCode",
               rd.rail_order_id AS "railOrderId", rd.status AS "railStatus",
               pr.name AS "railName"
        FROM payout_items pi
        JOIN payout_batches pb ON pb.id = pi.batch_id
        JOIN merchants m ON m.id = pi.merchant_id
        LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
        LEFT JOIN payment_rails pr ON pr.id = rd.rail_id
        WHERE pi.status = 'failed'
          AND pi.refund_status = 'approved'
          AND pi.failure_reason LIKE '%fetch failed%'
          AND rd.rail_id = ${'8fbc8c22-daba-4fcb-98ee-33ce7d8ffc74'}::uuid
        ORDER BY pi.created_at DESC
        LIMIT 50
      `,
    ]);
    const mapRow = r => ({
      ...r,
      amount:      Number(r.amount) / 100,
      itemFee:     Number(r.itemFee || 0) / 100,
      refundAmount: r.refundAmount ? Number(r.refundAmount) / 100 : null,
    });
    const items      = rows.map(mapRow);
    const watchItems = watchRows.map(mapRow);
    ok(res, { items, watchItems, total: items.length });
  } catch(e){ next(e); }
});

const PARALLEX_RAIL_ID = '8fbc8c22-daba-4fcb-98ee-33ce7d8ffc74';

// POST /admin/payout-review/:itemId/requery — live re-query Parallex for a single item
router.post('/payout-review/:itemId/requery', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { itemId } = req.params;

    const rows = await prisma.$queryRawUnsafe(`
      SELECT pi.id::text, pi.status, pi.refund_status AS "refundStatus",
             pi.amount::bigint AS amount,
             rd.rail_order_id AS "railOrderId", rd.rail_id::text AS "railId"
      FROM payout_items pi
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.id = $1::uuid
    `, itemId);

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Item not found' });
    const item = rows[0];

    if (!item.railOrderId) {
      return ok(res, { changed: false, status: item.status, note: 'No rail order ID — cannot re-query Parallex' });
    }
    if (item.railId !== PARALLEX_RAIL_ID) {
      return ok(res, { changed: false, status: item.status, note: 'Non-Parallex rail — re-query not supported' });
    }

    const parallexTransfer = require('../modules/gateway-core/services/parallexTransferService');
    let r;
    try {
      r = await parallexTransfer.queryPayoutResult({ orderId: item.railOrderId });
    } catch (err) {
      return ok(res, { changed: false, status: item.status, note: 'Parallex query failed: ' + err.message });
    }

    const orderStatus = r.orderStatus;

    if (orderStatus === '2' || orderStatus === '3') {
      await prisma.$executeRawUnsafe(
        `UPDATE payout_items SET status='success', failure_reason=NULL, updated_at=NOW() WHERE id=$1::uuid`, itemId);
      await prisma.$executeRawUnsafe(
        `UPDATE rail_disbursements SET status='success', updated_at=NOW() WHERE payout_item_id=$1::uuid`, itemId);
      return ok(res, { changed: true, status: 'success', note: `Parallex orderStatus ${orderStatus} — marked success. Money was sent.` });

    } else if (r.ok && !orderStatus) {
      // Code 30 NO RECORD — never sent; restore float only if currently held (not already restored)
      if (item.status === 'held') {
        await prisma.$executeRawUnsafe(
          `UPDATE payment_rails SET float_balance=float_balance+$1, updated_at=NOW() WHERE id=$2::uuid`,
          item.amount, PARALLEX_RAIL_ID);
      }
      await prisma.$executeRawUnsafe(
        `UPDATE payout_items SET status='failed', refund_status='pending_review', failure_reason='code 30 NO RECORD (re-queried by SA)', updated_at=NOW() WHERE id=$1::uuid`, itemId);
      await prisma.$executeRawUnsafe(
        `UPDATE rail_disbursements SET status='failed', updated_at=NOW() WHERE payout_item_id=$1::uuid`, itemId);
      return ok(res, { changed: true, status: 'failed', refundStatus: 'pending_review', note: 'Parallex code 30 — no record found. Rail float restored. Marked failed/pending_review.' });

    } else if (orderStatus === '1') {
      return ok(res, { changed: false, status: 'held', note: 'Still in-flight (Parallex status 1) — no change.' });

    } else {
      return ok(res, { changed: false, status: 'held', note: `Ambiguous result — ok=${r.ok} orderStatus=${orderStatus}. No change.` });
    }
  } catch(e) { next(e); }
});

// POST /admin/payout-review/:itemId/approve-refund — credit merchant wallet for confirmed failed payout
router.post('/payout-review/:itemId/approve-refund', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { itemId } = req.params;

    const rows = await prisma.$queryRawUnsafe(`
      SELECT pi.id::text, pi.status, pi.refund_status AS "refundStatus",
             pi.amount::bigint AS amount, pi.merchant_id::text AS "merchantId",
             rd.rail_id::text AS "railId"
      FROM payout_items pi
      LEFT JOIN rail_disbursements rd ON rd.payout_item_id = pi.id
      WHERE pi.id = $1::uuid
    `, itemId);

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Item not found' });
    const item = rows[0];

    if (item.status !== 'failed' || (item.refundStatus !== 'pending_review' && item.refundStatus !== null)) {
      return res.status(400).json({ ok: false, error: `Cannot approve: item is ${item.status}/${item.refundStatus}` });
    }

    const amount     = BigInt(item.amount);
    const merchantId = item.merchantId;
    const railId     = item.railId;

    // Get or create merchant wallet row and read current balance
    const walletRows = await prisma.$queryRawUnsafe(
      `SELECT balance::bigint AS balance FROM merchant_wallets WHERE merchant_id=$1::uuid AND rail_id=$2::uuid`,
      merchantId, railId
    );
    const before = walletRows.length ? BigInt(walletRows[0].balance) : 0n;
    const after  = before + amount;

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `INSERT INTO merchant_wallets (merchant_id, rail_id, balance, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, NOW())
         ON CONFLICT (merchant_id, rail_id) DO UPDATE SET balance = merchant_wallets.balance + $3, updated_at = NOW()`,
        merchantId, railId, amount
      ),
      prisma.$executeRawUnsafe(
        `INSERT INTO wallet_ledger
           (merchant_id, rail_id, entry_type, amount, balance_before, balance_after, reference, description, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, 'REVERSAL', $3, $4, $5, $6, $7, $8, NOW())`,
        merchantId, railId, amount, before, after,
        `REFUND-${itemId.slice(0, 8).toUpperCase()}`,
        `SA-approved refund — payout failed, Parallex confirmed no record`,
        req.user?.id || null
      ),
      prisma.$executeRawUnsafe(
        `UPDATE payout_items SET refund_status='approved', refund_amount=$1, updated_at=NOW() WHERE id=$2::uuid`,
        amount, itemId
      ),
    ]);

    ok(res, { credited: Number(amount) / 100, note: 'Wallet credited. Refund complete.' });
  } catch(e) { next(e); }
});

// POST /admin/payout-review/:itemId/reject-refund — mark as no-refund (money actually went through)
router.post('/payout-review/:itemId/reject-refund', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { itemId } = req.params;

    const rows = await prisma.$queryRawUnsafe(`
      SELECT pi.id::text, pi.status, pi.refund_status AS "refundStatus"
      FROM payout_items pi WHERE pi.id = $1::uuid
    `, itemId);

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Item not found' });
    const item = rows[0];

    if (item.status !== 'failed' || item.refundStatus !== 'pending_review') {
      return res.status(400).json({ ok: false, error: `Cannot reject: item is ${item.status}/${item.refundStatus}` });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE payout_items SET refund_status='rejected', failure_reason=COALESCE(failure_reason,'') || ' [SA: money sent — no refund]', updated_at=NOW() WHERE id=$1::uuid`,
      itemId
    );

    ok(res, { note: 'Marked rejected — no wallet credit. Item closed.' });
  } catch(e) { next(e); }
});

// ── GET /admin/kyc-updates — pending + recent KYC document update requests ────
router.get('/kyc-updates', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [pending, recent] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT kdu.id::text, kdu.doc_key, kdu.doc_label, kdu.file_path,
               kdu.merchant_notes, kdu.status, kdu.submitted_at::text,
               kdu.kyc_document_id::text,
               kd.file_path AS current_file_path, kd.status AS current_doc_status,
               m.business_name, m.merchant_code, kdu.merchant_id::text
        FROM kyc_document_updates kdu
        JOIN merchants m ON m.id = kdu.merchant_id
        LEFT JOIN kyc_documents kd ON kd.id = kdu.kyc_document_id
        WHERE kdu.status = 'pending'
        ORDER BY kdu.submitted_at ASC
      `),
      prisma.$queryRawUnsafe(`
        SELECT kdu.id::text, kdu.doc_key, kdu.doc_label, kdu.file_path,
               kdu.status, kdu.admin_notes, kdu.reviewed_at::text,
               kdu.previous_file_path,
               m.business_name, m.merchant_code
        FROM kyc_document_updates kdu
        JOIN merchants m ON m.id = kdu.merchant_id
        WHERE kdu.status IN ('approved','rejected')
        ORDER BY kdu.reviewed_at DESC
        LIMIT 20
      `),
    ]);
    ok(res, { pending, recent });
  } catch(e) { next(e); }
});

// ── POST /admin/kyc-updates/:id/approve ──────────────────────────────────────
router.post('/kyc-updates/:id/approve', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { admin_notes } = req.body;

    const rows = await prisma.$queryRawUnsafe(`
      SELECT id::text, merchant_id::text, kyc_document_id::text,
             doc_key, doc_label, file_path, status
      FROM kyc_document_updates WHERE id = $1::uuid
    `, id);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    const upd = rows[0];
    if (upd.status !== 'pending') return res.status(400).json({ ok: false, error: `Already ${upd.status}` });

    if (upd.kyc_document_id) {
      const oldDoc = await prisma.$queryRawUnsafe(
        `SELECT file_path FROM kyc_documents WHERE id = $1::uuid`, upd.kyc_document_id
      );
      const oldPath = oldDoc.length ? oldDoc[0].file_path : null;
      await prisma.$transaction([
        prisma.$executeRawUnsafe(
          `UPDATE kyc_documents SET file_path=$1, status='submitted', updated_at=NOW() WHERE id=$2::uuid`,
          upd.file_path, upd.kyc_document_id
        ),
        prisma.$executeRawUnsafe(
          `UPDATE kyc_document_updates SET status='approved', admin_notes=$1,
           reviewed_by=$2::uuid, reviewed_at=NOW(), previous_file_path=$3, updated_at=NOW()
           WHERE id=$4::uuid`,
          admin_notes || null, req.user?.id || null, oldPath, id
        ),
      ]);
    } else {
      // New doc type — create a live kyc_documents row
      const newDoc = await prisma.$queryRawUnsafe(`
        INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status, file_path, kind)
        VALUES ('merchant', $1::uuid, $2, $3, 'submitted', $4, 'document')
        RETURNING id::text
      `, upd.merchant_id, upd.doc_key, upd.doc_label, upd.file_path);
      await prisma.$executeRawUnsafe(
        `UPDATE kyc_document_updates SET status='approved', admin_notes=$1,
         reviewed_by=$2::uuid, reviewed_at=NOW(), kyc_document_id=$3::uuid, updated_at=NOW()
         WHERE id=$4::uuid`,
        admin_notes || null, req.user?.id || null, newDoc[0]?.id, id
      );
    }

    ok(res, { note: 'Approved — live KYC updated.' });
  } catch(e) { next(e); }
});

// ── POST /admin/kyc-updates/:id/reject ───────────────────────────────────────
router.post('/kyc-updates/:id/reject', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { admin_notes } = req.body;

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, status FROM kyc_document_updates WHERE id = $1::uuid`, id
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    if (rows[0].status !== 'pending') return res.status(400).json({ ok: false, error: `Already ${rows[0].status}` });

    await prisma.$executeRawUnsafe(
      `UPDATE kyc_document_updates SET status='rejected', admin_notes=$1,
       reviewed_by=$2::uuid, reviewed_at=NOW(), updated_at=NOW() WHERE id=$3::uuid`,
      admin_notes || null, req.user?.id || null, id
    );

    ok(res, { note: 'Update request rejected.' });
  } catch(e) { next(e); }
});

// ── GET /admin/kyc/:merchantId/history — full doc update history ──────────────
router.get('/kyc/:merchantId/history', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { merchantId } = req.params;
    const [docs, updates] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT id::text, doc_key, doc_label, status, file_path, kind, notes, updated_at::text
        FROM kyc_documents WHERE entity_type='merchant' AND entity_id=$1::uuid
        ORDER BY created_at ASC
      `, merchantId),
      prisma.$queryRawUnsafe(`
        SELECT id::text, doc_key, doc_label, file_path, previous_file_path,
               status, merchant_notes, admin_notes, submitted_at::text, reviewed_at::text
        FROM kyc_document_updates WHERE merchant_id=$1::uuid
        ORDER BY submitted_at DESC
      `, merchantId),
    ]);
    ok(res, { current_documents: docs, update_history: updates });
  } catch(e) { next(e); }
});

module.exports = router;
