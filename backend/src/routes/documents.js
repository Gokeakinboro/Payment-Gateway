'use strict';
// Per-document KYC/KYB tracking. Each required document for a merchant/aggregator
// is a row with an explicit status, so individual outstanding/deferred documents
// are tracked rather than buried in a free-text deferral reason.
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { ok, fail, notFound } = require('../utils/helpers');
const { requireAuth, requireCompliance, requireSuperAdmin, requireAdminOrCompliance } = require('../middleware/auth');
const path = require('path');
const fs   = require('fs');
const UPLOAD_DIR = process.env.ONBOARDING_UPLOAD_DIR || path.join(__dirname, '../../uploads/onboarding');
const { logAudit } = require('../services/auditService');
const { sendEmail, getEmailContent } = require('../services/emailService');
const { logger } = require('../utils/logger');

const VALID_DURATIONS = [1, 2, 3, 6];
const VALID_STATUSES  = ['outstanding', 'submitted', 'verified', 'deferred', 'overdue', 'waived', 'failed', 'rejected', 'reupload_requested'];

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

// Automated verification CHECKS (run via 3rd parties — Interswitch marketplace,
// pending). Tracked as rows so a FAILED check surfaces for manual review:
// compliance can then request a re-upload or manually approve/reject the item.
const CHECK_ITEMS = [
  { k: 'check_bvn',     l: 'BVN verification (check)' },
  { k: 'check_nin',     l: 'NIN verification (check)' },
  { k: 'check_address', l: 'Address verification (check)' },
  { k: 'check_tin',     l: 'TIN verification (check)' },
  { k: 'check_cac',     l: 'CAC verification (check)' },
  { k: 'check_id',      l: 'ID document check' },
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
  for (const d of [...DEFAULT_DOCS, ...CHECK_ITEMS]) {
    await prisma.$executeRaw`
      INSERT INTO kyc_documents (entity_type, entity_id, doc_key, doc_label, status)
      VALUES (${entityType}, ${entityId}::uuid, ${d.k}, ${d.l}, 'outstanding')
      ON CONFLICT (entity_type, entity_id, doc_key) DO NOTHING`;
  }
}

async function listDocs(entityType, entityId) {
  return prisma.$queryRaw`
    SELECT d.id::text, d.doc_key, d.doc_label, d.status, d.file_path, d.result,
           d.id_type, d.id_number, d.id_country, d.id_expiry, d.subject_name,
           d.deferred_until, d.deferred_by::text, d.notes, d.updated_at,
           COALESCE((
             SELECT json_agg(json_build_object('id', c.id::text, 'body', c.body,
                                                'author', c.author_email, 'at', c.created_at)
                              ORDER BY c.created_at)
             FROM kyc_document_comments c WHERE c.document_id = d.id
           ), '[]') AS comments
    FROM kyc_documents d
    WHERE d.entity_type = ${entityType} AND d.entity_id = ${entityId}::uuid
    ORDER BY d.doc_label ASC`;
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

// ── POST /api/v1/documents/item/:docId/request-reupload — ask merchant to resubmit
router.post('/item/:docId/request-reupload', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const [doc] = await prisma.$queryRaw`SELECT entity_type, entity_id::text, doc_label FROM kyc_documents WHERE id = ${req.params.docId}::uuid`;
    if (!doc) return notFound(res, 'Document');
    await prisma.$executeRaw`
      UPDATE kyc_documents SET status='reupload_requested', file_path=NULL,
             notes=${reason || 'Please re-submit this item.'}, updated_at=now()
      WHERE id = ${req.params.docId}::uuid`;
    // Notify the merchant (best-effort), if this is a merchant entity.
    if (doc.entity_type === 'merchant') {
      const m = await prisma.merchant.findUnique({ where: { id: doc.entity_id }, select: { businessEmail: true, businessName: true } });
      if (m?.businessEmail) {
        const content = await getEmailContent('kyc_reupload',
          { business: m.businessName, document: doc.doc_label, reason: reason || '' },
          `Action needed: re-submit "${doc.doc_label}"`,
          `<p>Dear ${m.businessName},</p><p>Please re-submit the following KYC item: <strong>${doc.doc_label}</strong>.</p>${reason ? `<p>Reason: ${reason}</p>` : ''}<p>Sign in to your dashboard to upload it.</p>`);
        sendEmail({ to: m.businessEmail, subject: content.subject, html: content.html }).catch(e => logger.error({ err: e }, 'reupload email failed'));
      }
    }
    await logAudit(req.user.id, 'KYC_REUPLOAD_REQUESTED', 'kyc_documents', req.params.docId, {}, { reason });
    ok(res, await listDocs(doc.entity_type, doc.entity_id), 'Re-upload requested');
  } catch (e) { next(e); }
});

// ── POST /api/v1/documents/item/:docId/run-check — automated 3rd-party verify ──
// STUB until the Interswitch marketplace APIs are wired. Marks the check as needing
// manual review; real integration will set verified/failed from the provider result.
router.post('/item/:docId/run-check', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const [doc] = await prisma.$queryRaw`SELECT entity_type, entity_id::text FROM kyc_documents WHERE id = ${req.params.docId}::uuid`;
    if (!doc) return notFound(res, 'Document');
    await prisma.$executeRaw`
      UPDATE kyc_documents SET status='submitted',
             notes='Automated verification pending Interswitch integration — manual review required', updated_at=now()
      WHERE id = ${req.params.docId}::uuid`;
    ok(res, await listDocs(doc.entity_type, doc.entity_id), 'Check queued (3rd-party integration pending — manual review for now).');
  } catch (e) { next(e); }
});

// ── Per-requirement RESULT (pass/fail/unknown) — SA + Admin + Compliance ─────
const VALID_RESULTS = ['pass', 'fail', 'unknown'];
router.patch('/item/:docId/result', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const result = String(req.body.result || '').toLowerCase();
    if (!VALID_RESULTS.includes(result)) return fail(res, 'result must be pass, fail or unknown');
    const [doc] = await prisma.$queryRaw`SELECT entity_type, entity_id::text FROM kyc_documents WHERE id = ${req.params.docId}::uuid`;
    if (!doc) return notFound(res, 'Document');
    await prisma.$executeRaw`UPDATE kyc_documents SET result = ${result}, updated_at = now() WHERE id = ${req.params.docId}::uuid`;
    await logAudit(req.user.id, 'KYC_REQUIREMENT_RESULT', 'kyc_documents', req.params.docId, {}, { result });
    ok(res, await listDocs(doc.entity_type, doc.entity_id), 'Result set to ' + result);
  } catch (e) { next(e); }
});

// ── Comments on a requirement (≤200 chars) — add: reviewers; remove: SA only ──
router.post('/item/:docId/comment', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body) return fail(res, 'Comment cannot be empty');
    if (body.length > 200) return fail(res, 'Comment must be 200 characters or fewer');
    const [doc] = await prisma.$queryRaw`SELECT entity_type, entity_id::text FROM kyc_documents WHERE id = ${req.params.docId}::uuid`;
    if (!doc) return notFound(res, 'Document');
    await prisma.$executeRaw`
      INSERT INTO kyc_document_comments (document_id, body, author_id, author_email)
      VALUES (${req.params.docId}::uuid, ${body}, ${req.user.id}::uuid, ${req.user.email})`;
    await logAudit(req.user.id, 'KYC_REQUIREMENT_COMMENT_ADDED', 'kyc_documents', req.params.docId, {}, { body });
    ok(res, await listDocs(doc.entity_type, doc.entity_id), 'Comment added');
  } catch (e) { next(e); }
});

router.delete('/comment/:commentId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const [c] = await prisma.$queryRaw`
      SELECT c.id, d.entity_type, d.entity_id::text
      FROM kyc_document_comments c JOIN kyc_documents d ON d.id = c.document_id
      WHERE c.id = ${req.params.commentId}::uuid`;
    if (!c) return notFound(res, 'Comment');
    await prisma.$executeRaw`DELETE FROM kyc_document_comments WHERE id = ${req.params.commentId}::uuid`;
    await logAudit(req.user.id, 'KYC_REQUIREMENT_COMMENT_REMOVED', 'kyc_document_comments', req.params.commentId, {}, {});
    ok(res, await listDocs(c.entity_type, c.entity_id), 'Comment removed');
  } catch (e) { next(e); }
});

// ── Uploaded document VIEWER (SA / Admin / Compliance) ───────────────────────
// The actual files an applicant uploaded at onboarding live on disk, referenced
// (relative to UPLOAD_DIR) in their OnboardingSubmission.documents[]. Reviewers
// must SEE these before they Pass/Fail/Defer the checklist items.

// The submission that provisioned this entity (merchantId is set on approval for
// both merchants and aggregators).
async function submissionForEntity(id) {
  return prisma.onboardingSubmission.findFirst({ where: { merchantId: id }, orderBy: { submittedAt: 'desc' } });
}

// GET /api/v1/documents/uploaded/:entityType/:id — list the uploaded files.
router.get('/uploaded/:entityType/:id', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const { entityType, id } = req.params;
    if (!entityCol(entityType)) return fail(res, 'entityType must be merchant or aggregator');
    const sub  = await submissionForEntity(id);
    const docs = (sub && Array.isArray(sub.documents)) ? sub.documents : [];
    ok(res, {
      reference: sub ? sub.reference : null,
      files: docs.map((d, i) => ({ i, key: d.key, name: d.name || d.key, doc_type: d.docType || null, principal: d.principal || null, has_file: !!d.path })),
    });
  } catch (e) { next(e); }
});

// GET /api/v1/documents/file/:ref/:idx — stream one uploaded file inline.
router.get('/file/:ref/:idx', requireAuth, requireAdminOrCompliance, async (req, res, next) => {
  try {
    const sub = await prisma.onboardingSubmission.findUnique({ where: { reference: req.params.ref } });
    if (!sub) return notFound(res, 'Submission');
    const docs = Array.isArray(sub.documents) ? sub.documents : [];
    const doc  = docs[parseInt(req.params.idx, 10)];
    if (!doc || !doc.path) return notFound(res, 'Document file');
    // Path-traversal guard: the resolved file MUST sit inside UPLOAD_DIR.
    const abs  = path.resolve(UPLOAD_DIR, doc.path);
    if (abs !== path.resolve(UPLOAD_DIR) && !abs.startsWith(path.resolve(UPLOAD_DIR) + path.sep))
      return fail(res, 'Invalid document path', 'BAD_PATH', 400);
    if (!fs.existsSync(abs)) return notFound(res, 'File not found on disk');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(doc.name || 'document').replace(/[^a-z0-9._-]/gi, '_') + '"');
    res.sendFile(abs);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.CHECK_ITEMS = CHECK_ITEMS;
