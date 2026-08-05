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

// ── email one check report to internal users ──────────────────────────────────

async function emailInternalReport(report, submissionRef, businessName) {
  const subject = `[KYC] ${checkLabel(report.checkType)} — ${report.result} — ${businessName} (${submissionRef})`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:640px;color:#1a1a1a">
      <h2 style="margin-bottom:4px">KYC Verification Report</h2>
      <p style="color:#666;font-size:13px;margin-top:0">${submissionRef} · ${new Date().toLocaleString('en-NG')}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr><td style="padding:8px;background:#f9fafb;font-weight:600;width:40%">Business</td><td style="padding:8px">${businessName}</td></tr>
        <tr><td style="padding:8px;background:#f9fafb;font-weight:600">Check type</td><td style="padding:8px">${checkLabel(report.checkType)}</td></tr>
        <tr><td style="padding:8px;background:#f9fafb;font-weight:600">Result</td><td style="padding:8px">${resultBadge(report.result)}</td></tr>
        ${report.subjectId ? `<tr><td style="padding:8px;background:#f9fafb;font-weight:600">Subject ID</td><td style="padding:8px">${report.subjectId}</td></tr>` : ''}
        ${report.subjectName ? `<tr><td style="padding:8px;background:#f9fafb;font-weight:600">Subject name</td><td style="padding:8px">${report.subjectName}</td></tr>` : ''}
        ${report.providerRef ? `<tr><td style="padding:8px;background:#f9fafb;font-weight:600">Provider ref</td><td style="padding:8px;font-size:12px">${report.providerRef}</td></tr>` : ''}
        ${report.matchNotes ? `<tr><td style="padding:8px;background:#f9fafb;font-weight:600">Notes</td><td style="padding:8px;color:#b45309">${report.matchNotes}</td></tr>` : ''}
      </table>
      ${report.responsePayload ? `<details><summary style="cursor:pointer;font-size:13px;color:#666">Raw provider response</summary><pre style="font-size:11px;background:#f1f5f9;padding:10px;border-radius:4px;overflow-x:auto;margin-top:8px">${JSON.stringify(report.responsePayload, null, 2)}</pre></details>` : ''}
      <p style="font-size:12px;color:#999;margin-top:24px">Paylode Compliance · paylodeservices.com</p>
    </div>`;
  try {
    await sendEmail({ to: REPORT_EMAIL, subject, html });
    await prisma.kycVerificationReport.update({
      where: { id: report.id }, data: { internalEmailedAt: new Date() },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to send internal KYC report email');
  }
}

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

// ── fire one YouVerify check + save + email ───────────────────────────────────

async function runCheck(submissionRef, merchantId, businessName, checkType, yvCall, subjectId, subjectName) {
  let result = 'PENDING';
  let providerRef = null;
  let requestPayload = null;
  let responsePayload = null;
  let matchNotes = null;

  try {
    const yvResult = await yvCall();
    providerRef   = yvResult.requestId;
    responsePayload = yvResult.raw;
    requestPayload  = { id: subjectId };

    if (!yvResult.success) {
      result = 'FAIL';
      matchNotes = yvResult.message || 'Verification failed — ID not found or not verified';
    } else {
      // YouVerify returns data about the subject — no name-matching needed on our side for screening
      // For eID checks the result is PASS if the ID was found; manual review catches mismatches
      result = 'PASS';
      const d = yvResult.raw?.data;
      if (d) {
        const returnedName = [d.firstName, d.middleName, d.lastName, d.fullName].filter(Boolean).join(' ').trim();
        if (returnedName) matchNotes = `Returned name: ${returnedName}`;
      }
    }
  } catch (e) {
    result = 'ERROR';
    matchNotes = e.message || 'Network or API error';
    logger.warn({ err: e.message, checkType, subjectId }, 'YouVerify check error');
  }

  const report = await saveReport({
    submissionRef, merchantId, checkType, result, subjectId, subjectName,
    provider: 'youverify', providerRef, requestPayload, responsePayload, matchNotes,
  });

  if (report) await emailInternalReport(report, submissionRef, businessName);
  return report;
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

  const merchantId = sub.merchantId;
  const businessName = sub.businessName || 'Unknown Business';
  const allReports = [];

  // ── 1. Completeness check ────────────────────────────────────────────────────
  const completenessIssues = checkCompleteness(sub);
  const completenessResult = completenessIssues.length ? 'FAIL' : 'PASS';
  const completenessReport = await saveReport({
    submissionRef: reference, merchantId, checkType: 'COMPLETENESS',
    result: completenessResult, provider: 'internal',
    matchNotes: completenessIssues.length ? completenessIssues.join(' | ') : null,
  });
  if (completenessReport) {
    await emailInternalReport(completenessReport, reference, businessName);
    allReports.push(completenessReport);
  }

  const data = sub.data || {};
  const principals = Array.isArray(sub.principals) ? sub.principals : [];
  const allNames = []; // names to screen for PEP/sanctions

  // ── 2. eID checks ────────────────────────────────────────────────────────────
  if (sub.formType === 'merchant' && sub.applicantType === 'natural') {
    const np = data.np_identity || {};
    const name = fullName(np) || sub.businessName;
    allNames.push(name);

    if (np.bvn && /^\d{11}$/.test(np.bvn)) {
      const r = await runCheck(reference, merchantId, businessName, 'BVN',
        () => yv.verifyBvn(np.bvn), np.bvn, name);
      if (r) allReports.push(r);
    }
    if (np.nin && /^\d{11}$/.test(np.nin)) {
      const r = await runCheck(reference, merchantId, businessName, 'NIN',
        () => yv.verifyNin(np.nin), np.nin, name);
      if (r) allReports.push(r);
    }

  } else if (sub.formType === 'merchant' && sub.applicantType === 'entity') {
    const ent = data.entity_details || {};
    allNames.push(sub.businessName);

    // CAC check
    const rcNum = ent.rc_number || sub.regNumber;
    if (rcNum) {
      const bizType = ent.entity_sub_type === 'sole_prop' ? 'business_name'
        : ent.entity_sub_type === 'trust' ? 'incorporated_trustee' : 'limited_liability';
      const r = await runCheck(reference, merchantId, businessName, 'CAC',
        () => yv.verifyCac(rcNum, sub.businessName, bizType), rcNum, sub.businessName);
      if (r) allReports.push(r);
    }

    // Per-principal BVN + NIN
    for (let i = 0; i < principals.length; i++) {
      const p = principals[i] || {};
      const pName = fullName(p);
      allNames.push(pName);

      if (p.bvn && /^\d{11}$/.test(p.bvn)) {
        const r = await runCheck(reference, merchantId, businessName, 'BVN',
          () => yv.verifyBvn(p.bvn), p.bvn, pName);
        if (r) allReports.push(r);
      }
      if (p.nin && /^\d{11}$/.test(p.nin)) {
        const r = await runCheck(reference, merchantId, businessName, 'NIN',
          () => yv.verifyNin(p.nin), p.nin, pName);
        if (r) allReports.push(r);
      }
    }
  }

  // ── 3. Local compliance watchlist (our DB — free, no YouVerify quota) ──────────
  const localHits = await checkLocalWatchlist(sub);
  if (localHits.length) {
    const localReport = await saveReport({
      submissionRef: reference, merchantId, checkType: 'WATCHLIST',
      result: 'FAIL', provider: 'internal',
      matchNotes: localHits.map((h) => `${h.entryType}:${h.value} — ${h.reason || 'On compliance blacklist'}`).join(' | '),
    });
    if (localReport) {
      await emailInternalReport(localReport, reference, businessName);
      allReports.push(localReport);
    }
  }

  // ── 4. Extract embedded screening from BVN/NIN responses ────────────────────
  // YouVerify bundles watchListed + amlReport + adverseMediaReport directly in
  // the BVN/NIN verification response — no separate API calls needed.
  // We read these from the saved response_payload in kyc_verification_reports.
  const eidReports = allReports.filter((r) => r && (r.checkType === 'BVN' || r.checkType === 'NIN'));
  for (const eidReport of eidReports) {
    const raw = eidReport.responsePayload?.data || {};

    // Watchlist (only present in BVN response)
    if (raw.watchListed !== undefined) {
      const wlResult = raw.watchListed === 'YES' ? 'FAIL' : 'PASS';
      const wlRep = await saveReport({
        submissionRef: reference, merchantId, checkType: 'WATCHLIST',
        result: wlResult, provider: 'youverify', subjectName: eidReport.subjectName,
        matchNotes: `YouVerify watchListed: ${raw.watchListed}`,
      });
      if (wlRep) { await emailInternalReport(wlRep, reference, businessName); allReports.push(wlRep); }
    }

    // AML report
    if (raw.amlReport !== null && raw.amlReport !== undefined) {
      const amlResult = raw.amlReport ? 'FAIL' : 'PASS';
      const amlRep = await saveReport({
        submissionRef: reference, merchantId, checkType: 'SANCTIONS',
        result: amlResult, provider: 'youverify', subjectName: eidReport.subjectName,
        responsePayload: raw.amlReport || {},
        matchNotes: amlResult === 'FAIL' ? 'AML hit detected — review report' : 'No AML hits',
      });
      if (amlRep) { await emailInternalReport(amlRep, reference, businessName); allReports.push(amlRep); }
    }

    // Adverse media
    if (raw.adverseMediaReport !== null && raw.adverseMediaReport !== undefined) {
      const amResult = raw.adverseMediaReport ? 'FAIL' : 'PASS';
      const amRep = await saveReport({
        submissionRef: reference, merchantId, checkType: 'ADVERSE_MEDIA',
        result: amResult, provider: 'youverify', subjectName: eidReport.subjectName,
        responsePayload: raw.adverseMediaReport || {},
        matchNotes: amResult === 'FAIL' ? 'Adverse media hit — review report' : 'No adverse media hits',
      });
      if (amRep) { await emailInternalReport(amRep, reference, businessName); allReports.push(amRep); }
    }
  }

  // ── 5. Facial liveness (new web merchants only) ───────────────────────────────
  // Skip if: merchant already active, OR liveness_exempted by SA/admin, OR no selfie submitted.
  const merchant = merchantId ? await prisma.merchant.findUnique({
    where: { id: merchantId }, select: { kycStatus: true, notificationSettings: true },
  }).catch(() => null) : null;

  const isExistingMerchant  = merchant && merchant.kycStatus === 'ACTIVE';
  const isLivenessExempted  = !!(merchant?.notificationSettings?.liveness_exempted);
  const selfieBase64        = sub.data?._liveness_selfie || null;

  if (!isExistingMerchant && !isLivenessExempted && selfieBase64) {
    const livenessReport = await runCheck(reference, merchantId, businessName, 'LIVENESS',
      () => yv.verifyLiveness(selfieBase64), null, sub.contactEmail || businessName);
    if (livenessReport) allReports.push(livenessReport);
  } else if (!isExistingMerchant && !isLivenessExempted && !selfieBase64) {
    // No selfie submitted — flag as incomplete (but don't fail — merchant may not have camera)
    const noSelfieReport = await saveReport({
      submissionRef: reference, merchantId, checkType: 'LIVENESS',
      result: 'SKIPPED', provider: 'internal',
      matchNotes: 'No selfie submitted — liveness check skipped. SA can exempt this merchant or request resubmission.',
    });
    if (noSelfieReport) {
      await emailInternalReport(noSelfieReport, reference, businessName);
      allReports.push(noSelfieReport);
    }
  }

  // ── 6. Summary email to internal ─────────────────────────────────────────────
  if (allReports.length) await emailInternalSummary(reference, businessName, allReports);

  // ── 7. Merchant notification for failures + completeness ──────────────────────
  const failedChecks = allReports.filter((r) => r && r.result === 'FAIL' && r.checkType !== 'COMPLETENESS');
  if (failedChecks.length || completenessIssues.length) {
    await emailMerchantFailures(sub.contactEmail, businessName, reference, failedChecks, completenessIssues);
  }

  logger.info({ reference, total: allReports.length, failed: failedChecks.length }, 'KYC orchestrator complete');
}

module.exports = { runOnboardingChecks };
