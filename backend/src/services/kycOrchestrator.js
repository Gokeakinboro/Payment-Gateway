'use strict';
/**
 * KYC Orchestrator — fires all YouVerify checks on onboarding submission/resubmission.
 *
 * On every submit or resubmit ALL checks are fired (not just deltas):
 *   1. Completeness check (no API call — form validation)
 *   2. BVN verification     (eID — natural persons + entity principals)
 *   3. NIN verification     (eID — natural persons + entity principals)
 *   4. CAC verification     (eID — entities only, by RC number)
 *   5. Local compliance watchlist (our DB — BVN/NIN/RC/name/email; no API quota)
 *   6. PEP screening        (all names — YouVerify)
 *   7. Sanctions screening  (all names — YouVerify)
 *   8. Adverse media        (all names — YouVerify)
 *   9. YouVerify custom watchlist (screens against watchlists configured in YV platform)
 *  10. Facial liveness (new web merchants only — skipped for existing active merchants
 *      and for merchants marked liveness_exempted by SA/admin)
 *
 * Each check result:
 *   - Saved to kyc_verification_reports (with full request/response)
 *   - Emailed individually to internal users (SA/compliance)
 *
 * After all checks:
 *   - Summary email to internal users
 *   - If any FAIL → email merchant with what failed + correction link
 *   - Completeness failures → email merchant immediately
 *
 * YouVerify PEP/sanctions/adverse-media endpoint paths are confirmed on account activation.
 * Set YOUVERIFY_PEP_PATH / YOUVERIFY_SANCTIONS_PATH / YOUVERIFY_ADVERSE_MEDIA_PATH env vars
 * if they differ from the defaults in youverifyService.js.
 */
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');
const { sendEmail } = require('./emailService');
const yv = require('./youverifyService');

const REPORT_EMAIL  = process.env.KYC_REPORT_EMAIL || process.env.COMPLIANCE_EMAIL || 'compliance@paylodeservices.com';
const APP_URL       = process.env.APP_URL || 'https://paylodeservices.com';
const ONBOARDING_URL = `${APP_URL}/onboarding.html?edit=1`;

// ── helpers ───────────────────────────────────────────────────────────────────

function fullName(p) {
  return [p.first_name, p.middle_name, p.surname].filter(Boolean).join(' ').trim() || p.name || '';
}

function resultBadge(r) {
  const colours = { PASS: '#16a34a', FAIL: '#dc2626', PENDING: '#d97706', ERROR: '#6b7280', SKIPPED: '#9ca3af' };
  return `<span style="background:${colours[r]||'#6b7280'};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">${r}</span>`;
}

function checkLabel(t) {
  return { BVN:'BVN Verification', NIN:'NIN Verification', CAC:'CAC/RC Verification',
    PEP:'PEP Screening', SANCTIONS:'Sanctions Screening', ADVERSE_MEDIA:'Adverse Media Screening',
    COMPLETENESS:'Form Completeness' }[t] || t;
}

// ── save a report row ─────────────────────────────────────────────────────────

async function saveReport({ submissionRef, merchantId, checkType, result, subjectId, subjectName,
  provider, providerRef, requestPayload, responsePayload, matchNotes }) {
  try {
    return await prisma.kycVerificationReport.create({
      data: {
        submissionRef, merchantId: merchantId || null, checkType, result,
        subjectId: subjectId || null, subjectName: subjectName || null,
        provider: provider || 'youverify',
        providerRef: providerRef || null,
        requestPayload: requestPayload || undefined,
        responsePayload: responsePayload || undefined,
        matchNotes: matchNotes || null,
      },
    });
  } catch (e) {
    logger.error({ err: e.message, checkType, submissionRef }, 'Failed to save KYC report row');
    return null;
  }
}

// Per-check emails removed — only the summary email is sent to compliance.
// Individual check results are stored in kyc_verification_reports and visible
// in the SA merchant modal → KYC Reports tab.

// ── email merchant about failures ─────────────────────────────────────────────

async function emailMerchantFailures(contactEmail, businessName, submissionRef, failedChecks, completenessIssues) {
  if (!contactEmail) return;
  const failLines = failedChecks.map((c) =>
    `<li><strong>${checkLabel(c.checkType)}</strong>${c.subjectName ? ` (${c.subjectName})` : ''}${c.matchNotes ? ` — ${c.matchNotes}` : ''}</li>`).join('');
  const completeLines = completenessIssues.map((i) => `<li>${i}</li>`).join('');
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:600px;color:#1a1a1a">
      <h2>Action required — KYC verification issue</h2>
      <p>Dear <strong>${businessName}</strong>,</p>
      <p>We have reviewed your onboarding application (ref: <strong>${submissionRef}</strong>) and encountered the following issues that must be resolved before your account can proceed:</p>
      ${failedChecks.length ? `<h3 style="color:#dc2626">Failed verifications</h3><ul>${failLines}</ul><p>Please correct the relevant information and resubmit your application.</p>` : ''}
      ${completenessIssues.length ? `<h3 style="color:#d97706">Incomplete information</h3><ul>${completeLines}</ul>` : ''}
      <p><a href="${ONBOARDING_URL}" style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">Correct and resubmit</a></p>
      <p style="font-size:13px;color:#666;margin-top:24px">If you have questions, reply to this email or contact us at support@paylodeservices.com.</p>
      <p style="font-size:12px;color:#999">Paylode · EagleCrest Premium Services Ltd</p>
    </div>`;
  try {
    await sendEmail({
      to: contactEmail,
      subject: `Action required: KYC verification issue — ${businessName}`,
      html,
    });
    await prisma.kycVerificationReport.updateMany({
      where: { submissionRef, result: { in: ['FAIL', 'ERROR'] }, merchantEmailedAt: null },
      data: { merchantEmailedAt: new Date() },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to send merchant KYC failure email');
  }
}

// ── summary email to internal ─────────────────────────────────────────────────

async function emailInternalSummary(submissionRef, businessName, reports) {
  const rows = reports.map((r) =>
    `<tr>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9">${checkLabel(r.checkType)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9">${r.subjectName || r.subjectId || '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9">${resultBadge(r.result)}</td>
      <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#666">${r.matchNotes || ''}</td>
    </tr>`).join('');
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:700px;color:#1a1a1a">
      <h2>KYC Verification Summary</h2>
      <p style="color:#666">${businessName} · ${submissionRef} · ${new Date().toLocaleString('en-NG')}</p>
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <thead><tr style="background:#f1f5f9">
          <th style="text-align:left;padding:10px 8px">Check</th>
          <th style="text-align:left;padding:10px 8px">Subject</th>
          <th style="text-align:left;padding:10px 8px">Result</th>
          <th style="text-align:left;padding:10px 8px">Notes</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#999;margin-top:24px">Paylode Compliance · paylodeservices.com</p>
    </div>`;
  try {
    await sendEmail({
      to: REPORT_EMAIL,
      subject: `[KYC Summary] ${businessName} (${submissionRef}) — ${reports.filter((r) => r.result === 'FAIL').length} failed`,
      html,
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to send KYC summary email');
  }
}

// ── local compliance watchlist check ─────────────────────────────────────────
// Screens BVN, NIN, RC number, names and email against our internal compliance_watchlist table.
// Zero YouVerify quota — runs before any external API calls.
async function checkLocalWatchlist(sub) {
  const hits = [];
  try {
    const data       = sub.data || {};
    const principals = Array.isArray(sub.principals) ? sub.principals : [];
    const checks     = [];

    // BVN / NIN for natural persons
    const np = data.np_identity || {};
    if (np.bvn) checks.push({ entryType: 'BVN',   value: String(np.bvn).trim() });
    if (np.nin) checks.push({ entryType: 'NIN',    value: String(np.nin).trim() });

    // Entity: RC number + per-principal BVN/NIN
    const ent = data.entity_details || {};
    if (ent.rc_number || sub.regNumber)
      checks.push({ entryType: 'RC', value: String(ent.rc_number || sub.regNumber).trim().toUpperCase() });
    for (const p of principals) {
      if (p.bvn) checks.push({ entryType: 'BVN', value: String(p.bvn).trim() });
      if (p.nin) checks.push({ entryType: 'NIN', value: String(p.nin).trim() });
    }

    // Email + phone (all forms)
    if (sub.contactEmail) checks.push({ entryType: 'EMAIL', value: sub.contactEmail.toLowerCase() });
    if (sub.contactPhone) checks.push({ entryType: 'PHONE', value: sub.contactPhone.replace(/\s+/g, '') });

    // Name screening (business name + principal names)
    const names = [sub.businessName, ...principals.map((p) => fullName(p))].filter(Boolean);
    for (const n of names)
      checks.push({ entryType: 'NAME', value: n.toLowerCase().trim() });

    for (const c of checks) {
      const hit = await prisma.complianceWatchlist.findFirst({
        where: { entryType: c.entryType, value: c.value, isActive: true },
      });
      if (hit) hits.push(hit);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Local watchlist check failed (non-fatal)');
  }
  return hits;
}

// ── settlement account name matching ─────────────────────────────────────────
// Compares the settlement account name the merchant provided against the name
// returned by YouVerify (BVN/NIN for natural persons, CAC for entities).
// Uses word-overlap matching — handles bank abbreviations, title omissions etc.
// Returns { pass, submittedName, verifiedName, score, reason }.
function matchSettlementName(submittedName, verifiedName) {
  if (!submittedName || !verifiedName) return { pass: false, reason: 'One or both names are missing' };

  const normalize = (s) => String(s).toUpperCase()
    .replace(/\bLIMITED\b/g, 'LTD').replace(/\bCOMPANY\b/g, 'CO')
    .replace(/\bAND\b/g, '&').replace(/[^A-Z0-9&\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const sWords = new Set(normalize(submittedName).split(' ').filter((w) => w.length > 1));
  const vWords = new Set(normalize(verifiedName).split(' ').filter((w) => w.length > 1));
  if (!sWords.size || !vWords.size) return { pass: false, reason: 'Name could not be parsed' };

  const overlap = [...sWords].filter((w) => vWords.has(w)).length;
  const score = overlap / Math.max(sWords.size, vWords.size);
  const pass = score >= 0.5; // ≥50% word overlap required
  return {
    pass, score: Math.round(score * 100),
    submittedName, verifiedName,
    reason: pass
      ? `Name match (${Math.round(score * 100)}% overlap)`
      : `Name mismatch — settlement account "${submittedName}" does not sufficiently match verified name "${verifiedName}" (${Math.round(score * 100)}% overlap)`,
  };
}

async function runSettlementNameCheck(submissionRef, merchantId, sub, eidReports) {
  // Get settlement account name from form data
  const settlementAccountName = (sub.data?.np_business?.account_name || '').trim();
  if (!settlementAccountName) {
    return saveReport({
      submissionRef, merchantId, checkType: 'SETTLEMENT_NAME', result: 'SKIPPED',
      provider: 'internal', matchNotes: 'No settlement account name provided',
    });
  }

  // For natural persons — match against BVN/NIN returned name
  if (sub.applicantType === 'natural') {
    const bvnReport = eidReports.find((r) => r.checkType === 'BVN' && r.result === 'PASS');
    const verifiedName = bvnReport
      ? [bvnReport.responsePayload?.data?.firstName, bvnReport.responsePayload?.data?.lastName].filter(Boolean).join(' ')
      : null;
    const match = matchSettlementName(settlementAccountName, verifiedName);
    return saveReport({
      submissionRef, merchantId, checkType: 'SETTLEMENT_NAME',
      result: match.pass ? 'PASS' : 'FAIL', provider: 'internal',
      subjectName: settlementAccountName,
      matchNotes: match.reason,
    });
  }

  // For entities — match against CAC returned company name
  if (sub.applicantType === 'entity') {
    const cacReport = eidReports.find((r) => r.checkType === 'CAC' && r.result === 'PASS');
    const verifiedName = cacReport?.responsePayload?.data?.name || cacReport?.responsePayload?.data?.companyName || null;
    const match = matchSettlementName(settlementAccountName, verifiedName);
    return saveReport({
      submissionRef, merchantId, checkType: 'SETTLEMENT_NAME',
      result: match.pass ? 'PASS' : 'FAIL', provider: 'internal',
      subjectName: settlementAccountName,
      matchNotes: match.reason,
    });
  }

  return null;
}

// ── completeness check ────────────────────────────────────────────────────────

function checkCompleteness(sub) {
  const issues = [];
  const { formType, applicantType, data = {}, principals = [], documents = [] } = sub;

  if (!sub.businessName) issues.push('Business name is missing');
  if (!sub.contactEmail) issues.push('Contact email is missing');
  if (!sub.contactPhone) issues.push('Contact phone is missing');

  if (formType === 'merchant') {
    if (applicantType === 'natural') {
      const np = data.np_identity || {};
      if (!np.bvn || !/^\d{11}$/.test(String(np.bvn))) issues.push('Valid 11-digit BVN is required');
      if (!np.nin || !/^\d{11}$/.test(String(np.nin))) issues.push('Valid 11-digit NIN is required');
      if (!np.address) issues.push('Residential address is missing');
    } else if (applicantType === 'entity') {
      const ent = data.entity_details || {};
      if (!ent.rc_number && !sub.regNumber) issues.push('RC number (CAC registration) is missing');
      if (!ent.registered_address) issues.push('Registered company address is missing');
      if (!principals.length) issues.push('At least one director/owner with BVN and NIN is required');
      for (let i = 0; i < principals.length; i++) {
        const p = principals[i] || {};
        if (!p.bvn || !/^\d{11}$/.test(String(p.bvn))) issues.push(`Director/owner #${i + 1}: valid BVN required`);
        if (!p.nin || !/^\d{11}$/.test(String(p.nin))) issues.push(`Director/owner #${i + 1}: valid NIN required`);
      }
    }
    const np_biz = data.np_business || {};
    if (!np_biz.bank_name && !np_biz.account_number) issues.push('Settlement bank account details are missing');
  }

  return issues;
}

// ── fire one YouVerify check + save (no per-check email) ─────────────────────

async function runCheck(submissionRef, merchantId, checkType, yvCall, subjectId, subjectName) {
  let result = 'PENDING', providerRef = null, requestPayload = null, responsePayload = null, matchNotes = null;

  try {
    const yvResult = await yvCall();
    providerRef     = yvResult.requestId;
    responsePayload = yvResult.raw;
    requestPayload  = { id: subjectId };

    if (!yvResult.success) {
      result = 'FAIL';
      matchNotes = yvResult.message || 'Verification failed — not found or not verified';
    } else {
      result = 'PASS';
      const d = yvResult.raw?.data || {};
      const returnedName = [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ').trim();
      if (returnedName) matchNotes = `Returned name: ${returnedName}`;
    }
  } catch (e) {
    result = 'ERROR';
    matchNotes = e.message || 'Network or API error';
    logger.warn({ err: e.message, checkType, subjectId }, 'YouVerify check error');
  }

  return saveReport({ submissionRef, merchantId, checkType, result, subjectId, subjectName,
    provider: 'youverify', providerRef, requestPayload, responsePayload, matchNotes });
}

// ── main entry point ──────────────────────────────────────────────────────────

async function runOnboardingChecks(reference) {
  if (!process.env.YOUVERIFY_API_KEY) {
    logger.info({ reference }, 'YouVerify not configured — skipping KYC checks');
    return;
  }

  let sub;
  try {
    sub = await prisma.onboardingSubmission.findUnique({
      where: { reference },
      select: {
        reference: true, merchantId: true, formType: true, applicantType: true,
        businessName: true, contactEmail: true, contactPhone: true, regNumber: true, tin: true,
        data: true, principals: true, documents: true, status: true,
      },
    });
  } catch (e) {
    logger.error({ err: e.message, reference }, 'kycOrchestrator: failed to load submission');
    return;
  }

  if (!sub) { logger.warn({ reference }, 'kycOrchestrator: submission not found'); return; }

  const merchantId   = sub.merchantId;
  const businessName = sub.businessName || 'Unknown Business';
  const allReports   = [];
  const data         = sub.data || {};
  const principals   = Array.isArray(sub.principals) ? sub.principals : [];
  const allNames     = []; // collect all names for AML/adverse media

  // ── 1. Completeness ──────────────────────────────────────────────────────────
  const completenessIssues = checkCompleteness(sub);
  const cr = await saveReport({
    submissionRef: reference, merchantId, checkType: 'COMPLETENESS',
    result: completenessIssues.length ? 'FAIL' : 'PASS', provider: 'internal',
    matchNotes: completenessIssues.length ? completenessIssues.join(' | ') : null,
  });
  if (cr) allReports.push(cr);

  // ── 2. Local compliance watchlist (free, no API quota) ───────────────────────
  const localHits = await checkLocalWatchlist(sub);
  if (localHits.length) {
    const wr = await saveReport({
      submissionRef: reference, merchantId, checkType: 'WATCHLIST', result: 'FAIL', provider: 'internal',
      matchNotes: localHits.map((h) => `${h.entryType}:${h.value} — ${h.reason || 'On compliance blacklist'}`).join(' | '),
    });
    if (wr) allReports.push(wr);
  }

  // ── 3. eID checks (BVN / NIN / CAC) ─────────────────────────────────────────
  if (sub.formType === 'merchant' && sub.applicantType === 'natural') {
    const np = data.np_identity || {};
    const name = fullName(np) || sub.businessName;
    allNames.push(name);

    if (np.bvn && /^\d{11}$/.test(np.bvn)) {
      const r = await runCheck(reference, merchantId, 'BVN', () => yv.verifyBvn(np.bvn), np.bvn, name);
      if (r) allReports.push(r);
    }
    if (np.nin && /^\d{11}$/.test(np.nin)) {
      const r = await runCheck(reference, merchantId, 'NIN', () => yv.verifyNin(np.nin), np.nin, name);
      if (r) allReports.push(r);
    }

  } else if (sub.formType === 'merchant' && sub.applicantType === 'entity') {
    const ent = data.entity_details || {};
    allNames.push(sub.businessName);

    const rcNum = ent.rc_number || sub.regNumber;
    if (rcNum) {
      const r = await runCheck(reference, merchantId, 'CAC', () => yv.verifyCac(rcNum, sub.businessName), rcNum, sub.businessName);
      if (r) allReports.push(r);
    }
    for (const p of principals) {
      const pName = fullName(p);
      allNames.push(pName);
      if (p.bvn && /^\d{11}$/.test(p.bvn)) {
        const r = await runCheck(reference, merchantId, 'BVN', () => yv.verifyBvn(p.bvn), p.bvn, pName);
        if (r) allReports.push(r);
      }
      if (p.nin && /^\d{11}$/.test(p.nin)) {
        const r = await runCheck(reference, merchantId, 'NIN', () => yv.verifyNin(p.nin), p.nin, pName);
        if (r) allReports.push(r);
      }
    }
  }

  // ── 3b. Settlement account name check ───────────────────────────────────────
  // Must run after eID checks so we have verified names to compare against.
  const eidReports = allReports.filter((r) => r && ['BVN', 'NIN', 'CAC'].includes(r.checkType));
  const snReport = await runSettlementNameCheck(reference, merchantId, sub, eidReports);
  if (snReport) allReports.push(snReport);

  // ── 4. Embedded BVN/NIN screening (watchlist / AML bundled in response) ──────
  for (const eidR of eidReports.filter((r) => r.checkType === 'BVN' || r.checkType === 'NIN')) {
    const raw = eidR.responsePayload?.data || {};
    if (raw.watchListed !== undefined) {
      const r = await saveReport({
        submissionRef: reference, merchantId, checkType: 'WATCHLIST',
        result: raw.watchListed === 'YES' ? 'FAIL' : 'PASS', provider: 'youverify',
        subjectName: eidR.subjectName, matchNotes: `YouVerify watchListed: ${raw.watchListed}`,
      });
      if (r) allReports.push(r);
    }
    if (raw.amlReport !== null && raw.amlReport !== undefined) {
      const r = await saveReport({
        submissionRef: reference, merchantId, checkType: 'SANCTIONS',
        result: raw.amlReport ? 'FAIL' : 'PASS', provider: 'youverify',
        subjectName: eidR.subjectName, responsePayload: raw.amlReport || {},
        matchNotes: raw.amlReport ? 'AML hit detected — review report' : 'No AML hits',
      });
      if (r) allReports.push(r);
    }
    if (raw.adverseMediaReport !== null && raw.adverseMediaReport !== undefined) {
      const r = await saveReport({
        submissionRef: reference, merchantId, checkType: 'ADVERSE_MEDIA',
        result: raw.adverseMediaReport ? 'FAIL' : 'PASS', provider: 'youverify',
        subjectName: eidR.subjectName, responsePayload: raw.adverseMediaReport || {},
        matchNotes: raw.adverseMediaReport ? 'Adverse media hit — review' : 'No adverse media hits',
      });
      if (r) allReports.push(r);
    }
  }

  // ── 5. AML (PEP + sanctions) + adverse media via direct API ──────────────────
  const uniqueNames = [...new Set(allNames.filter(Boolean))];
  for (const name of uniqueNames) {
    const entityType = sub.applicantType === 'entity' ? 'business' : 'individual';
    const amlR = await runCheck(reference, merchantId, 'AML',
      () => yv.screenAml(name, entityType), null, name);
    if (amlR) allReports.push(amlR);

    const amR = await runCheck(reference, merchantId, 'ADVERSE_MEDIA',
      () => yv.screenAdverseMedia(name, entityType), null, name);
    if (amR) allReports.push(amR);
  }

  // ── 6. Liveness (new merchants only, if selfie submitted) ────────────────────
  const merchant = merchantId ? await prisma.merchant.findUnique({
    where: { id: merchantId }, select: { kycStatus: true, notificationSettings: true },
  }).catch(() => null) : null;
  const isActive   = merchant?.kycStatus === 'ACTIVE';
  const isExempted = !!(merchant?.notificationSettings?.liveness_exempted);
  const selfie     = sub.data?._liveness_selfie || null;

  if (!isActive && !isExempted) {
    if (selfie) {
      const r = await runCheck(reference, merchantId, 'LIVENESS',
        () => yv.verifyLiveness(selfie), null, sub.contactEmail || businessName);
      if (r) allReports.push(r);
    } else {
      const r = await saveReport({
        submissionRef: reference, merchantId, checkType: 'LIVENESS', result: 'SKIPPED', provider: 'internal',
        matchNotes: 'No selfie submitted — liveness skipped. SA may exempt or request resubmission.',
      });
      if (r) allReports.push(r);
    }
  }

  // ── 7. ONE summary email to compliance ───────────────────────────────────────
  if (allReports.length) await emailInternalSummary(reference, businessName, allReports);

  // ── 8. Notify merchant only if there are failures ────────────────────────────
  const failedChecks = allReports.filter((r) => r && r.result === 'FAIL' && r.checkType !== 'COMPLETENESS');
  if (failedChecks.length || completenessIssues.length) {
    await emailMerchantFailures(sub.contactEmail, businessName, reference, failedChecks, completenessIssues);
  }

  logger.info({ reference, total: allReports.length, failed: failedChecks.length }, 'KYC orchestrator complete');
}

module.exports = { runOnboardingChecks };
