'use strict';
// Per-document KYC/KYB tracking. Each required document for a merchant/aggregator
// is a row with an explicit status, so individual outstanding/deferred documents
// are tracked rather than buried in a free-text deferral reason.
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { ok, fail, notFound } = require('../utils/helpers');
const { requireAuth, requireCompliance, requireSuperAdmin } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');

const VALID_DURATIONS = [1, 2, 3, 6];
const VALID_STATUSES  = ['outstanding', 'submitted', 'verified', 'deferred', 'overdue', 'waived'];

// Default required-document set seeded for an entity (corporate baseline + KYC).
// Superadmin can waive the ones that don't apply (e.g. MEMART for a sole trader).
const DEFAULT_DOCS = [
  { k: 'cert_incorp',     l: 'Certificate of Incorporation / Registration' },
  { k: 'memart',          l: 'MEMART (companies)' },
  { k: 'status_report',   l: 'CAC Status Report (or Form CO2 + CO7)' },
  { k: 'board_resolution',l: 'Board Resolution authorising the account' },
  { k: 'tin_cert',        l: 'Tax Identification Number (TIN) certificate' },
  { k: 'proof_address',   l: 'Proof of business address (≤3 months)' },
  { k: 'directors_id',    l: 'Directors’ IDs + BVN' },
  { k: 'shareholders_id', l: 'Shareholders’ / UBO IDs + BVN' },
];

function entityCol(entityType) {
  if (entityType === 'merchant' || entityType === 'aggregator') return entityType;
  return null;
}

async function seedIfEmpty(entityType, entityId) {
  const [{ cnt }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS cnt FROM kyc_documents
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
  if (cnt > 0) return;
  for (const d of DEFAULT_DOCS) {
    await prisma.$executeRaw`
      INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status)
      VALUES (${entityType}, ${entityId}::uuid, ${d.k}, ${d.l}, 'outstanding')
      ON CONFLICT (entity_type, entity_id, doc_key) DO NOTHING`;
  }
}

async function listDocs(entityType, entityId) {
  return prisma.$queryRaw`
    SELECT id::text, doc_key, doc_label, status, file_path,
           deferred_until, deferred_by::text, notes, updated_at
    FROM kyc_documents
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid
    ORDER BY doc_label ASC`;
}

// ── GET /api/v1/documents/:entityType/:id ─────────────────────────────────────
router.get('/:entityType/:id', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    if (!entityCol(entityType)) return fail(res, 'entityType must be merchant or aggregator');
    await seedIfEmpty(entityType, id);
    const docs = await listDocs(entityType, id);
    const summary = docs.reduce((a, d) => { a[d.status] = (a[d.status] || 0) + 1; return a; }, {});
    ok(res, { docs, summary });
  } catch (e) { next(e); }
});

// ── PATCH /api/v1/documents/item/:docId — update one document's status/notes ──
router.patch('/item/:docId', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { status, notes, file_path } = req.body;
    if (status && !VALID_STATUSES.includes(status)) return fail(res, 'Invalid status');
    const [doc] = await prisma.$queryRaw`SELECT entity_type, entity_id::text FROM kyc_documents WHERE id = ${req.params.docId}::uuid`;
    if (!doc) return notFound(res, 'Document');
    await prisma.$executeRaw`
      UPDATE kyc_documents SET
        status         = COALESCE(${status || null}, status),
        notes          = COALESCE(${notes ?? null}, notes),
        file_path      = COALESCE(${file_path ?? null}, file_path),
        deferred_until = CASE WHEN ${status || ''} IN ('submitted','verified','waived') THEN NULL ELSE deferred_until END,
        updated_at     = now()
      WHERE id = ${req.params.docId}::uuid`;
    await logAudit(req.user.id, 'KYC_DOCUMENT_UPDATED', 'kyc_documents', req.params.docId, {}, { status, notes });
    ok(res, await listDocs(doc.entity_type, doc.entity_id), 'Document updated');
  } catch (e) { next(e); }
});

// ── POST /api/v1/documents/:entityType/:id/defer — defer SPECIFIC documents ───
router.post('/:entityType/:id/defer', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    const { doc_ids, duration_months, reason } = req.body;
    if (!entityCol(entityType)) return fail(res, 'entityType must be merchant or aggregator');
    if (!Array.isArray(doc_ids) || !doc_ids.length) return fail(res, 'doc_ids[] is required');
    if (!VALID_DURATIONS.includes(Number(duration_months))) return fail(res, 'duration_months must be 1, 2, 3 or 6');

    const expiresAt = new Date(); expiresAt.setMonth(expiresAt.getMonth() + Number(duration_months));

    for (const docId of doc_ids) {
      await prisma.$executeRaw`
        UPDATE kyc_documents SET status='deferred', deferred_until=${expiresAt},
               deferred_by=${req.user.id}::uuid, notes=COALESCE(${reason || null}, notes), updated_at=now()
        WHERE id = ${docId}::uuid AND entity_type = ${entityType} AND entity_id = ${id}::uuid`;
    }

    // Activate the account now that outstanding docs are formally deferred.
    if (entityType === 'merchant') {
      await prisma.merchant.update({ where: { id }, data: { isActive: true, kycStatus: 'ACTIVE' } });
    } else {
      await prisma.aggregator.update({ where: { id }, data: { status: 'active' } });
    }

    await logAudit(req.user.id, 'KYC_DOCUMENTS_DEFERRED', entityType + 's', id, {}, { doc_ids, duration_months, expires_at: expiresAt, reason });
    ok(res, await listDocs(entityType, id), `${doc_ids.length} document(s) deferred until ${expiresAt.toDateString()}. Account active.`);
  } catch (e) { next(e); }
});

// ── POST /api/v1/documents/:entityType/:id/add — add a custom required doc ────
router.post('/:entityType/:id/add', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    const { doc_key, doc_label } = req.body;
    if (!entityCol(entityType)) return fail(res, 'entityType must be merchant or aggregator');
    if (!doc_key || !doc_label) return fail(res, 'doc_key and doc_label are required');
    await prisma.$executeRaw`
      INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status)
      VALUES (${entityType}, ${id}::uuid, ${doc_key}, ${doc_label}, 'outstanding')
      ON CONFLICT (entity_type, entity_id, doc_key) DO NOTHING`;
    ok(res, await listDocs(entityType, id), 'Document requirement added');
  } catch (e) { next(e); }
});

module.exports = router;
