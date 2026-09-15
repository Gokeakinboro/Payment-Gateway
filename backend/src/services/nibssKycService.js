'use strict';
/**
 * NIBSS NPS — Identity / KYC verification client (BVN · RC · TIN).
 *
 * NPS bundles KYC verification into the same rail that carries payments, so this
 * is the same credentials + the same signed transport as the payout/VA client
 * (modules/gateway-core/services/nibssNpsService.js) — only the endpoints differ.
 * Transport is imported rather than duplicated so token caching, request signing
 * and the 401-replay stay in ONE place; this mirrors the existing
 * routes/paymentLinks.js → gateway-core/services/feeEngine.js precedent.
 *
 * Returns the SAME normalise() shape as interswitchKycService / youverifyService,
 * so it plugs straight into the per-requirement PASS/FAIL framework
 * (documents.js matchAgainstForm, kycOrchestrator runCheck) with no framework
 * change — the provider swap is a one-line require at those call sites.
 *
 * ⚠️  NOT WIRED INTO THE LIVE KYC PATH. documents.js / kyc.js / kycOrchestrator
 * still import youverifyService. Switching providers is a commercial decision
 * (per-check pricing vs YouVerify/Dojah — see config/serviceProviders.js) and is
 * deliberately left to a separate change once NPS KYC pricing is agreed.
 *
 * ⚠️  Endpoint paths are UNCONFIRMED — the NPS portal is IP-allowlisted and not
 * reachable until our IP Form clears. Every path is env-overridable
 * (NIBSS_NPS_KYC_*_PATH) so sandbox can correct them without a code change.
 *
 * SCOPE NOTE: NPS covers BVN / RC / TIN. It does NOT cover NIN, facial liveness,
 * PEP, sanctions or adverse media — those stay with the incumbent provider even
 * after a BVN/RC/TIN switch.
 *
 * Config (env): reuses NIBSS_NPS_CLIENT_ID / _CLIENT_SECRET / _PRIVATE_KEY /
 * _BASE_URL / _INSTITUTION_CODE from the NPS client, plus:
 *   NIBSS_NPS_KYC_BVN_PATH  default /nps/api/v1/kyc/bvn
 *   NIBSS_NPS_KYC_RC_PATH   default /nps/api/v1/kyc/rc
 *   NIBSS_NPS_KYC_TIN_PATH  default /nps/api/v1/kyc/tin
 */
const nps = require('../modules/gateway-core/services/nibssNpsService');

const PATHS = {
  bvn: process.env.NIBSS_NPS_KYC_BVN_PATH || '/nps/api/v1/kyc/bvn',
  rc:  process.env.NIBSS_NPS_KYC_RC_PATH  || '/nps/api/v1/kyc/rc',
  tin: process.env.NIBSS_NPS_KYC_TIN_PATH || '/nps/api/v1/kyc/tin',
};

function isConfigured() { return nps.isConfigured(); }

/**
 * Map an NPS KYC response to the common verification shape.
 * Success = an explicit verified flag, or a '00'/VERIFIED status, AND the call
 * itself did not fail. A transport failure is reported as success:false with the
 * reason surfaced — never as a silent FAIL, so the framework can tell a genuine
 * mismatch apart from an outage.
 */
function normalise(res, type) {
  const r = res || {};
  const failed = nps.callFailed(r);
  const verified = nps.dig(r, 'data.verified', 'verified', 'Vrfctn');
  const status = nps.dig(r, 'data.status', 'status', 'responseStatus');
  const code = nps.dig(r, 'data.responseCode', 'responseCode', 'code');
  const ok = !failed && (verified === true || String(code) === '00' || /verified|success/i.test(String(status || '')));
  return {
    success: ok,
    requestId: nps.dig(r, 'data.reference', 'reference', 'data.requestId', 'requestId') || null,
    status: status || (ok ? 'VERIFIED' : 'NOT_VERIFIED'),
    message: nps.reasonOf(r) || nps.dig(r, 'data.message', 'message', 'responseMessage') ||
      (failed ? (r.reason || 'NPS KYC request failed') : ''),
    data: {
      firstName:      nps.dig(r, 'data.firstName', 'firstName', 'data.firstname'),
      lastName:       nps.dig(r, 'data.lastName', 'lastName', 'data.surname'),
      middleName:     nps.dig(r, 'data.middleName', 'middleName'),
      birthDate:      nps.dig(r, 'data.dateOfBirth', 'dateOfBirth', 'data.birthDate'),
      gender:         nps.dig(r, 'data.gender', 'gender'),
      phone:          nps.dig(r, 'data.phoneNumber', 'phoneNumber', 'data.phone'),
      identityNumber: nps.dig(r, 'data.bvn', 'bvn', 'data.identityNumber', 'identityNumber'),
      companyName:    nps.dig(r, 'data.companyName', 'companyName', 'data.businessName'),
      rcNumber:       nps.dig(r, 'data.rcNumber', 'rcNumber', 'data.registrationNumber'),
      tin:            nps.dig(r, 'data.tin', 'tin', 'data.taxIdentificationNumber'),
      registrationDate: nps.dig(r, 'data.registrationDate', 'registrationDate'),
      address:        nps.dig(r, 'data.address', 'address'),
    },
    raw: r,
    type,
  };
}

// ── BVN ──────────────────────────────────────────────────────────────────────
// Optional name/DOB are sent so NPS can match server-side; the framework still
// runs its OWN name/DOB match on the returned fields and flags exceptions.
async function verifyBvn(bvn, fields = {}) {
  const res = await nps.call(PATHS.bvn, {
    GrpHdr: nps.groupHeader('KYCB'),
    bvn: String(bvn || '').trim(),
    ...(fields.firstName && { firstName: fields.firstName }),
    ...(fields.lastName  && { lastName:  fields.lastName  }),
    ...(fields.birthDate && { dateOfBirth: fields.birthDate }),   // yyyy-MM-dd
    ...(fields.phone     && { phoneNumber: fields.phone     }),
  });
  return normalise(res, 'bvn');
}

// ── RC (CAC company registration) ────────────────────────────────────────────
// Named verifyCac as well, so swapping this in at the existing call sites
// (documents.js / kycOrchestrator) needs no rename.
async function verifyRc(rcNumber, businessName, businessType) {
  const res = await nps.call(PATHS.rc, {
    GrpHdr: nps.groupHeader('KYCR'),
    rcNumber: String(rcNumber || '').trim(),
    ...(businessName && { businessName }),
    ...(businessType && { businessType }),
  });
  return normalise(res, 'cac');
}

// ── TIN (FIRS tax identification number) ─────────────────────────────────────
async function verifyTin(tin, businessName) {
  const res = await nps.call(PATHS.tin, {
    GrpHdr: nps.groupHeader('KYCT'),
    tin: String(tin || '').trim(),
    ...(businessName && { businessName }),
  });
  return normalise(res, 'tin');
}

module.exports = {
  isConfigured, normalise, PATHS,
  verifyBvn, verifyRc, verifyCac: verifyRc, verifyTin,
};
