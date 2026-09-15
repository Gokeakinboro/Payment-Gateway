'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS NPS callbacks. Three inbound notifications:
//    POST /api/v1/webhooks/nibss/payout     — pacs.002 FIToFIPaymentStatusReport
//    POST /api/v1/webhooks/nibss/va-credit  — camt.054 credit notification
//    POST /api/v1/webhooks/nibss/recall     — camt.029 resolution of investigation
//  The BASE path is a dispatcher + catch-all (NPS may be configured with a single
//  notification URL at institution level), so no NPS callback ever 404s.
//
//  Every callback is signature-verified against NIBSS's public key over the RAW
//  request bytes — re-serialising a parsed body reorders keys and breaks an
//  otherwise valid signature. req.rawBody is stashed by the path-scoped parser in
//  appFactory.js; it MUST live there, not here, because the global express.json()
//  runs before this router and a second parser would no-op (req._body already set).
//
//  The payout handler deliberately does NO money logic of its own: it maps the
//  ISO 20022 status to our numeric orderStatus and hands off to the SHARED
//  applyPayoutResult (services/payoutSettle.js) — the same code the stuck-'sent'
//  poller uses, so push and poll can never diverge on money.
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const nps = require('../services/nibssNpsService');
const { prisma } = require('../../../utils/db');
const { logger } = require('../../../utils/logger');
const { finalizePayinSuccess } = require('../services/payinFinalize');
const { applyPayoutResult } = require('../services/payoutSettle');

// NIBSS signs callbacks with its private key; we verify with NIBSS_NPS_PUBLIC_KEY.
// Until that key is issued we accept and LOUDLY log (scaffold mode) — the same
// stance palmpay-webhook.js takes, so sandbox testing isn't blocked on key exchange.
function verified(req) {
  if (!process.env.NIBSS_NPS_PUBLIC_KEY) {
    logger.warn('NPS callback received but NIBSS_NPS_PUBLIC_KEY not set — cannot verify (scaffold mode)');
    return true;
  }
  const sig = req.get('Signature') || req.get('X-Signature') || '';
  return nps.verifyCallback(req.body, sig, req.rawBody);
}

// ── payout result (pacs.002) ────────────────────────────────────────────────
// OrgnlEndToEndId is the rail_order_id we set on the pacs.008 — that is the key
// applyPayoutResult matches the in-flight leg on.
async function handlePayout(req, res) {
  const b = req.body || {};
  if (!verified(req)) {
    logger.warn({ msgId: nps.dig(b, 'GrpHdr.MsgId') }, 'NPS payout callback: BAD signature');
    return res.status(401).json({ status: 'RJCT', message: 'invalid signature' });
  }
  const orderId = nps.dig(b,
    'FIToFIPmtStsRpt.TxInfAndSts.OrgnlEndToEndId', 'TxInfAndSts.OrgnlEndToEndId',
    'data.endToEndId', 'endToEndId', 'orderId');
  const txSts = nps.txStatusOf(b);
  const orderStatus = nps.orderStatusFor(txSts);
  logger.info({ orderId, txSts, orderStatus, sessionId: nps.sessionIdOf(b) }, 'NPS payout result');
  if (!orderId) {
    logger.warn({ body: b }, 'NPS payout callback carried no end-to-end id — ignored');
    return res.status(200).json({ status: 'ACSC' });
  }
  await applyPayoutResult({
    orderId,
    orderNo: nps.providerRefOf(b),
    sessionId: nps.sessionIdOf(b),
    orderStatus,
    errorMsg: nps.reasonOf(b),
    source: 'webhook',
  });
  return res.status(200).json({ status: 'ACSC' });
}

// ── virtual-account credit (camt.054) ───────────────────────────────────────
// Mirrors the PalmPay VA cash-in flow. Case (1) — a PENDING checkout txn tagged
// with this VA — is handled here via the shared finalizePayinSuccess.
//
// Case (2), a STATIC per-merchant VA, is NOT credited yet: that path deducts a
// merchant-funded fee and books a collection, and the fee math currently lives
// inline in palmpay-webhook.js. Lifting it into a shared service is a money-path
// refactor that needs its own change + sign-off, so an unmatched NPS credit is
// logged for manual handling rather than half-credited. Registering NPS static
// VAs is gated on that work.
async function handleVaCredit(req, res) {
  const b = req.body || {};
  if (!verified(req)) {
    logger.warn('NPS VA credit callback: BAD signature');
    return res.status(401).json({ status: 'RJCT', message: 'invalid signature' });
  }
  const vaNo = nps.dig(b,
    'Ntfctn.Acct.Id.Othr.Id', 'BkToCstmrDbtCdtNtfctn.Ntfctn.Acct.Id.Othr.Id',
    'data.accountNumber', 'accountNumber', 'virtualAccountNumber');
  // Amt is either { Ccy, value } or a bare scalar depending on the encoding, so
  // resolve the NODE and let amountOf unwrap it — reading '.value' directly would
  // silently yield undefined on the scalar form, which then skips the
  // exact-amount enforcement below and credits an underpayment in full.
  const amountNaira = nps.amountOf(nps.dig(b,
    'Ntfctn.Ntry.Amt', 'BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.Amt',
    'data.amount', 'amount'));
  const cdtDbtInd = nps.dig(b, 'Ntfctn.Ntry.CdtDbtInd', 'data.indicator', 'indicator');
  const npsRef = nps.dig(b,
    'Ntfctn.Ntry.NtryRef', 'Ntfctn.Ntry.AcctSvcrRef', 'data.reference', 'reference') || null;
  const payer = nps.dig(b,
    'Ntfctn.Ntry.NtryDtls.TxDtls.RltdPties.Dbtr.Pty.Nm', 'data.payerName', 'payerName') || null;

  logger.info({ vaNo, amountNaira, cdtDbtInd, npsRef, payer }, 'NPS VA credit');

  // Only CREDITs fund a collection; a debit notification is informational.
  if (!vaNo || (cdtDbtInd && String(cdtDbtInd).toUpperCase() !== 'CRDT')) {
    return res.status(200).json({ status: 'ACSC' });
  }
  // An unparseable amount must NOT fall through as `null` — that disables the
  // exact-amount check in finalizePayinSuccess. Acknowledge (so NPS stops
  // retrying) and leave it for manual handling rather than credit blind.
  const amountNum = Number(amountNaira);
  if (amountNaira == null || !Number.isFinite(amountNum)) {
    logger.error({ vaNo, npsRef, amountNaira },
      'NPS VA credit carried no parseable amount — NOT credited, needs manual handling');
    return res.status(200).json({ status: 'ACSC' });
  }
  const paidKobo = Number(nps.koboFromNaira(amountNum));

  try {
    const t = await prisma.$queryRaw`
      SELECT reference FROM transactions
      WHERE status = 'PENDING' AND metadata->>'nps_va_no' = ${vaNo}
      ORDER BY created_at DESC LIMIT 1`;
    if (t.length) {
      const r = await finalizePayinSuccess({
        reference: t[0].reference, channel: 'BANK_TRANSFER', processor: 'nibss_nps_va',
        extraMeta: { method: 'nibss_nps_va', nps_va_no: vaNo, nps_reference: npsRef, payer },
        paidAmount: paidKobo,                  // enforce exact amount
      });
      if (r && r.amountMismatch) {
        // Deliberately NOT auto-reversed: the NPS return leg is camt.056/pacs.004
        // and is not wired yet. Flag loudly for manual treasury action instead.
        logger.warn({ vaNo, npsRef, expected: r.expected, paid: r.paid },
          'NPS VA credit AMOUNT MISMATCH — not credited, needs manual reversal (pacs.004 not wired)');
      }
      return res.status(200).json({ status: 'ACSC' });
    }
    logger.warn({ vaNo, npsRef, paidKobo },
      'NPS VA credit: no matching PENDING checkout txn — static-VA collections not wired yet, needs manual handling');
    return res.status(200).json({ status: 'ACSC' });
  } catch (e) {
    logger.error({ err: e, vaNo, npsRef }, 'NPS VA credit processing failed');
    return res.status(500).json({ status: 'RJCT' });   // NPS will retry
  }
}

// ── recall resolution (camt.029) ────────────────────────────────────────────
// NPS answers a camt.056 recall asynchronously. We do NOT move money here: a
// recall that NIBSS accepts still settles as a pacs.004 return on a later leg.
// Recorded so support can see the outcome against the original payout.
async function handleRecall(req, res) {
  const b = req.body || {};
  if (!verified(req)) {
    logger.warn('NPS recall callback: BAD signature');
    return res.status(401).json({ status: 'RJCT', message: 'invalid signature' });
  }
  logger.info({
    orderId: nps.dig(b, 'RsltnOfInvstgtn.CxlDtls.TxInfAndSts.OrgnlEndToEndId', 'data.endToEndId', 'endToEndId'),
    status:  nps.dig(b, 'RsltnOfInvstgtn.Sts.Conf', 'data.status', 'status'),
    reason:  nps.reasonOf(b),
  }, 'NPS recall resolution');
  return res.status(200).json({ status: 'ACSC' });
}

router.post('/payout',    (req, res) => handlePayout(req, res).catch(e => { logger.error({ err: e }, 'NPS payout callback failed'); res.status(500).json({ status: 'RJCT' }); }));
router.post('/va-credit', (req, res) => handleVaCredit(req, res).catch(e => { logger.error({ err: e }, 'NPS VA callback failed'); res.status(500).json({ status: 'RJCT' }); }));
router.post('/recall',    (req, res) => handleRecall(req, res).catch(e => { logger.error({ err: e }, 'NPS recall callback failed'); res.status(500).json({ status: 'RJCT' }); }));

// Base dispatcher + catch-all: route on the ISO 20022 message type when NPS is
// configured with one institution-level notification URL.
router.post('*', (req, res) => {
  const b = req.body || {};
  const hint = String(
    req.get('X-Message-Type') || b.messageType || b.MsgDefIdr ||
    Object.keys(b).find(k => /FIToFIPmtStsRpt|BkToCstmrDbtCdtNtfctn|RsltnOfInvstgtn/.test(k)) || ''
  );
  const handler =
    /pacs\.?002|FIToFIPmtStsRpt/i.test(hint)            ? handlePayout   :
    /camt\.?054|BkToCstmrDbtCdtNtfctn/i.test(hint)      ? handleVaCredit :
    /camt\.?029|RsltnOfInvstgtn/i.test(hint)            ? handleRecall   : null;
  if (!handler) {
    logger.warn({ path: req.path, hint, keys: Object.keys(b) }, 'Unrecognised NPS callback — acknowledged, not processed');
    return res.status(200).json({ status: 'ACSC' });
  }
  return handler(req, res).catch(e => { logger.error({ err: e, hint }, 'NPS callback failed'); res.status(500).json({ status: 'RJCT' }); });
});

module.exports = router;
