'use strict';
/**
 * Paylode — Mastercard Rules compliance engine.
 *
 * Two entry points:
 *   screenMerchant()    — onboarding-time merchant due diligence (BRAM / MCC / sanctions
 *                         / PEP / MATCH / enhanced-DD), returns an exceptions[] list.
 *   screenTransaction() — synchronous per-transaction pre-authorization gate (Phase B).
 *
 * Sanctions screening goes through screenName(), a stable interface backed by the local
 * list today (data/sanctionsList.js) and a live API later — drop-in, same signature.
 *
 * Severity model (see config/complianceRules.js):
 *   BLOCKING — hard-blocks; only a SUPER_ADMIN force-ack can override.
 *   REVIEW   — SA dispositions: defer-and-proceed, clear (false positive), or block.
 *   MONITOR  — flagged (amlFlag) and allowed.
 *
 * Note on sanctions/PEP at ONBOARDING: a name match is a *possible* hit (namesakes are
 * common), so it is raised as REVIEW for manual disposition rather than auto-BLOCKING.
 * Genuinely illegal categories (prohibited MCC, BRAM activity, confirmed MATCH listing)
 * are BLOCKING. On the live transaction gate, sanctions matches hard-block (Phase B).
 */

const rules = require('../config/complianceRules');
const sanctions = require('../data/sanctionsList');
const { prisma } = require('../utils/db');

const { SEVERITY, REASON_CODES, SCOPES } = rules;

// ── Sanctions interface (swap the body for a live API later) ──────────────────
// Returns null (clear) or { matched, matchType, source, listedName, country }.
function screenName(name, _opts = {}) {
  const hit = sanctions.match(name);
  if (!hit) return null;
  return {
    matched: true,
    matchType: hit.matchType,
    source: hit.entry.source,
    listedName: hit.entry.name,
    country: hit.entry.country || null,
  };
}

// ── PCI guard — never store/log PAN or CVV ────────────────────────────────────
const PCI_KEYS = /(card_?number|pan|cvv|cvc|card_?cvv|card_?pin)/i;
function looksLikePan(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length >= 13 && d.length <= 19 && luhnValid(d);
}
function luhnValid(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}
// Return a deep copy safe to log: PAN/CVV/PIN keys and PAN-looking values redacted.
function redactPan(obj) {
  if (obj == null || typeof obj !== 'object') {
    return (typeof obj === 'string' && looksLikePan(obj)) ? '[REDACTED_PAN]' : obj;
  }
  if (Array.isArray(obj)) return obj.map(redactPan);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (PCI_KEYS.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactPan(v);
  }
  return out;
}
// Throw if a PAN/CVV is present where it must never be persisted (defensive).
function assertNoPan(obj, context = 'object') {
  const json = JSON.stringify(obj || {});
  if (PCI_KEYS.test(json)) {
    // Key present is only a problem if a value is too — but be strict for storage paths.
    throw new Error(`PCI violation: card secret field present in ${context}`);
  }
  return true;
}

// ── Field extraction from an onboarding submission's flexible `data` shape ─────
function extractScope(data = {}) {
  if (data.card_acceptance_scope === SCOPES.INTERNATIONAL) return SCOPES.INTERNATIONAL;
  if (data.card_acceptance_scope === SCOPES.LOCAL) return SCOPES.LOCAL;
  const biz = data.np_business || {};
  return biz.mkt_intl === '1' ? SCOPES.INTERNATIONAL : SCOPES.LOCAL;
}
function extractMcc(data = {}) {
  return data.mcc || (data.np_business || {}).mcc || (data.entity_details || {}).mcc || null;
}
function extractDescription(data = {}) {
  const biz = data.np_business || {};
  const ent = data.entity_details || {};
  return [
    data.business_description, biz.nature, biz.description, biz.trading_name,
    ent.nature_of_business, ent.registered_name,
  ].filter(Boolean).join(' . ');
}
function fullName(p = {}) {
  return [p.first_name, p.other_names, p.surname].filter(Boolean).join(' ').trim();
}

// Required enhanced-DD docs for international card acceptance (beyond the base set).
const INTL_EDD_DOCS = ['business_model_doc', 'refund_delivery_policy', 'processing_history'];

/**
 * screenMerchant — onboarding-time due diligence.
 * @param {object} input { applicantType, data, principals[], scope?, mcc?, matchListed?, documents? }
 * @returns { exceptions[], pepFlag, sanctionsHit, riskLevel, screeningNotes[], scope, mcc }
 *          (superset of the legacy screen() shape for back-compat).
 */
function screenMerchant(input = {}) {
  const { applicantType, data = {}, principals = [], matchListed = false, documents = [] } = input;
  const scope = input.scope || extractScope(data);
  const mcc = input.mcc || extractMcc(data);
  const description = extractDescription(data);

  const exceptions = [];
  const notes = [];

  // 1) MCC + BRAM matrix (scope-aware).
  for (const f of rules.evaluate(scope, mcc, description)) {
    exceptions.push(f);
    notes.push(`${f.severity}: ${f.description}`);
  }

  // 2) Sanctions + PEP across the applicant + all principals.
  const np = data.np_identity || {};
  const subjects = [];
  if (applicantType === 'natural') subjects.push({ name: fullName(np), role: 'Applicant', pep: np.is_pep === 'yes' });
  for (const p of principals) subjects.push({ name: fullName(p), role: p.role || 'Principal', pep: !!p.is_pep });

  let pepFlag = false, sanctionsHit = false;
  for (const s of subjects) {
    if (!s.name) continue;
    const hit = screenName(s.name);
    if (hit) {
      sanctionsHit = true;
      exceptions.push({
        code: REASON_CODES.MC_SANCTIONS, severity: SEVERITY.REVIEW, deferrable: true,
        description: `Possible sanctions match for ${s.role} "${s.name}" → listed "${hit.listedName}" (${hit.source}, ${hit.matchType}) — manual disposition required`,
        ruleRef: 'Mastercard Rules — sanctions screening / OFAC-UN-EU',
      });
      notes.push(`Possible sanctions match: "${s.name}" vs "${hit.listedName}" (${hit.source}).`);
    }
    if (s.pep) {
      pepFlag = true;
      exceptions.push({
        code: REASON_CODES.MC_PEP, severity: SEVERITY.REVIEW, deferrable: true,
        description: `${s.role} "${s.name}" is a politically exposed person (PEP) — enhanced due diligence required`,
        ruleRef: 'AML/CFT — PEP enhanced due diligence',
      });
      notes.push(`${s.role} ${s.name} declared/identified as a PEP.`);
    }
  }

  // 3) MATCH / terminated-merchant listing (manual flag now; network lookup later).
  if (matchListed) {
    exceptions.push({
      code: REASON_CODES.MC_MATCH, severity: SEVERITY.BLOCKING, deferrable: false,
      description: 'Merchant/principal appears on MATCH (terminated merchant file) — onboarding prohibited',
      ruleRef: 'Mastercard Rules — MATCH (Member Alert To Control High-risk merchants)',
    });
    notes.push('MATCH-listed — onboarding prohibited.');
  }

  // 4) Enhanced-DD docs for international scope.
  if (scope === SCOPES.INTERNATIONAL) {
    const present = new Set((documents || []).map(d => (d.key || '').replace(/^doc_/, '')));
    const missing = INTL_EDD_DOCS.filter(k => !present.has(k));
    if (missing.length) {
      exceptions.push({
        code: REASON_CODES.MC_MISSING_EDD, severity: SEVERITY.REVIEW, deferrable: true,
        description: `International card acceptance requires enhanced due-diligence documents — missing: ${missing.join(', ')}`,
        ruleRef: 'Mastercard Rules — cross-border / high-risk programme requirements',
      });
      notes.push(`Missing enhanced-DD docs for international scope: ${missing.join(', ')}.`);
    }
  }

  // 5) Risk band (drives the dashboard badge; same buckets as the legacy screen()).
  const biz = data.np_business || {};
  const highVol = ['50to200m', 'above200m'].includes(biz.expected_monthly_value);
  const hasBlocking = exceptions.some(e => e.severity === SEVERITY.BLOCKING);
  const hasReview = exceptions.some(e => e.severity === SEVERITY.REVIEW);
  let riskLevel = 'low';
  if (hasBlocking || pepFlag || sanctionsHit) riskLevel = 'high';
  else if (hasReview || scope === SCOPES.INTERNATIONAL || highVol) riskLevel = 'medium';
  else if (biz.expected_monthly_value && biz.expected_monthly_value !== 'below1m') riskLevel = 'medium';

  if (sanctions.getIndex().count === 0) notes.push('Note: sanctions list empty — configure a list/feed before go-live.');

  return { exceptions, pepFlag, sanctionsHit, riskLevel, screeningNotes: notes, scope, mcc };
}

/**
 * screenTransaction — synchronous per-transaction pre-authorization gate (Phase B).
 * IN-MEMORY ONLY (no DB round-trips) so it is safe on the latency-sensitive charge
 * path. Enforces the HARD PROHIBITIONS that the Mastercard Rules / law require to be
 * blocked before a transaction reaches the rail. Risk/heuristic signals (velocity,
 * round-amounts, etc.) are NOT blocked here — they stay monitor-only via amlService.
 *
 * @param {object} merchant  full merchant record (mcc, cardAcceptanceScope,
 *                           complianceStatus, matchListed, isActive)
 * @param {object} ctx       { customerName?, customerEmail?, cardCountry? } — cardCountry
 *                           is the issuer/BIN country (ISO-2), populated by MPGS later.
 * @returns {{decision:'ALLOW'|'REJECT', reasonCode:?string, message:string}}
 */
function screenTransaction(merchant, ctx = {}) {
  const reject = (reasonCode, message) => ({ decision: 'REJECT', reasonCode, message });

  if (!merchant) return reject(REASON_CODES.MC_BLOCKED_MERCHANT, 'Unknown merchant');
  if (merchant.matchListed) return reject(REASON_CODES.MC_MATCH, 'Merchant is MATCH-listed (terminated merchant file)');
  if (merchant.complianceStatus === 'blocked') return reject(REASON_CODES.MC_BLOCKED_MERCHANT, 'Merchant is compliance-blocked');

  const scope = merchant.cardAcceptanceScope === SCOPES.INTERNATIONAL ? SCOPES.INTERNATIONAL : SCOPES.LOCAL;
  const cls = rules.classifyMcc(merchant.mcc, scope);
  if (cls.classification === 'prohibited')
    return reject(REASON_CODES.MC_PROHIBITED_MCC, `Merchant category (MCC ${merchant.mcc}) is prohibited for ${scope} card acceptance`);

  if (ctx.customerName) {
    const hit = screenName(ctx.customerName);
    if (hit) return reject(REASON_CODES.MC_SANCTIONS, `Customer name matches a sanctions listing (${hit.source})`);
  }
  if (ctx.cardCountry && sanctions.isSanctionedCountry(ctx.cardCountry))
    return reject(REASON_CODES.MC_SANCTIONS, `Card issued in a sanctioned jurisdiction (${ctx.cardCountry})`);

  return { decision: 'ALLOW', reasonCode: null, message: 'cleared' };
}

// Back-compat wrapper matching the legacy onboarding.js screen() signature/return.
function screen(applicantType, data, principals) {
  const r = screenMerchant({ applicantType, data, principals });
  return { pepFlag: r.pepFlag, sanctionsHit: r.sanctionsHit, riskLevel: r.riskLevel, screeningNotes: r.screeningNotes };
}

// ── Persistence (raw SQL — no prisma-client regen needed, like documents.js) ──

/**
 * persistExceptions — upsert screening findings for an entity. New findings insert as
 * 'open'; an existing row's status (an SA disposition) is NEVER clobbered by re-screening
 * — only the description/severity/ref are refreshed. Then rolls up the merchant status.
 */
async function persistExceptions(entityType, entityId, findings = []) {
  for (const f of findings) {
    await prisma.$executeRaw`
      INSERT INTO compliance_exceptions
        (entity_type, entity_id, rule_code, severity, status, description, rule_ref, deferrable)
      VALUES (${entityType}, ${entityId}::uuid, ${f.code}, ${f.severity}, 'open',
              ${f.description || null}, ${f.ruleRef || null}, ${f.deferrable !== false})
      ON CONFLICT (entity_type, entity_id, rule_code) DO UPDATE
        SET severity = EXCLUDED.severity, description = EXCLUDED.description,
            rule_ref = EXCLUDED.rule_ref, deferrable = EXCLUDED.deferrable, updated_at = now()`;
  }
  if (entityType === 'merchant') await rollupComplianceStatus(entityId);
  return listExceptions(entityType, entityId);
}

async function listExceptions(entityType, entityId) {
  return prisma.$queryRaw`
    SELECT id::text, rule_code, severity, status, description, rule_ref,
           deferrable, deferred_until, deferred_by::text, reason, created_at, updated_at
    FROM compliance_exceptions
    WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid
    ORDER BY (severity='BLOCKING') DESC, created_at DESC`;
}

/**
 * rollupComplianceStatus — derive merchants.compliance_status from open exceptions:
 *   blocked — any BLOCKING exception still open/blocked (cannot go active)
 *   review  — any REVIEW exception still open
 *   clear   — otherwise
 * Returns the computed status.
 */
async function rollupComplianceStatus(merchantId) {
  const [row] = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE severity='BLOCKING' AND status IN ('open','blocked'))::int AS blocking,
      COUNT(*) FILTER (WHERE severity='REVIEW'   AND status='open')::int                AS review
    FROM compliance_exceptions
    WHERE entity_type='merchant' AND entity_id=${merchantId}::uuid`;
  const status = row.blocking > 0 ? 'blocked' : row.review > 0 ? 'review' : 'clear';
  await prisma.$executeRaw`UPDATE merchants SET compliance_status=${status} WHERE id=${merchantId}::uuid`;
  return status;
}

// True if the merchant has any unresolved BLOCKING exception (must not go active / charge).
async function hasOpenBlocking(entityType, entityId) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM compliance_exceptions
    WHERE entity_type=${entityType} AND entity_id=${entityId}::uuid
      AND severity='BLOCKING' AND status IN ('open','blocked')`;
  return row.n > 0;
}

module.exports = {
  screenName, screenMerchant, screenTransaction, screen,
  redactPan, assertNoPan, looksLikePan,
  persistExceptions, listExceptions, rollupComplianceStatus, hasOpenBlocking,
  INTL_EDD_DOCS,
};
