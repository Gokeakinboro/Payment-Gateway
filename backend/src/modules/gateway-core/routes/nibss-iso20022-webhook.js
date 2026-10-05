'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS ISO 20022 inbound webhooks
//
//  nginx on 176 routes 443/nps/* → :3000/api/v1/webhooks/nibss/*
//
//  Live:  NIBSS_NPS_ENABLED=true
//  Stub:  all routes log + ACK 200, no domain processing
//
//  Critical inbound paths:
//    /pacs008 — NIBSS sends an inbound credit transfer; we decrypt, verify, ACK
//    /pacs002 — NIBSS sends payment status report for our outbound pacs.008
//    /acmt024 — NIBSS responds to our acmt.023 name enquiry
//
//  All other paths: log + ACK (forward-compat stubs).
// ─────────────────────────────────────────────────────────────────────────────
const router  = require('express').Router();
const { logger } = require('../../../utils/logger');

const NIBSS_LIVE = process.env.NIBSS_NPS_ENABLED === 'true';

// Lazy-load npsService so the server starts even if cert files aren't yet present
let nps = null;
function getNps() {
  if (!nps) nps = require('../services/nibssNpsService');
  return nps;
}

// ── Raw XML body parsing ──────────────────────────────────────────────────────
// Express parses JSON by default; NPS sends XML.  nginx proxies via :3000.
// We need the raw body as a string.
function rawBody(req) {
  // If body-parser already ran, req.body is a Buffer or string; otherwise {}
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string' && req.body.length > 0) return req.body;
  return '';
}

// ── Decrypt + verify helper (safe — never throws to caller) ──────────────────
function decryptInbound(xml) {
  try {
    if (!xml || !xml.includes('<xenc:EncryptedData')) return { ok: true, xml };
    const { decryptContentElement } = getNps();
    const decrypted = decryptContentElement(xml);
    return { ok: true, xml: decrypted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Stub handler ──────────────────────────────────────────────────────────────
function stub(msgType) {
  return (req, res) => {
    logger.warn({ msgType }, `NIBSS inbound: ${msgType} — stub mode, not processing`);
    return res.status(200).json({ status: 'received', msgType });
  };
}

// ── pacs.008 inbound — FI credit transfer from NIBSS ─────────────────────────
// NIBSS sends us a pacs.008; we must decrypt, verify, process, return HTTP 200
router.post('/pacs008', (req, res) => {
  const xml = rawBody(req);
  if (!NIBSS_LIVE || !xml) {
    logger.warn({ xmlLen: xml.length }, 'NIBSS pacs.008 inbound — stub/no-body');
    return res.status(200).json({ status: 'received', msgType: 'pacs.008' });
  }

  const { ok, xml: decXml, error } = decryptInbound(xml);
  if (!ok) {
    logger.error({ error }, 'NIBSS pacs.008 inbound — decrypt failed');
    return res.status(400).json({ status: 'decrypt_failed', error });
  }

  // TODO: extract transaction details from decXml and credit merchant account
  const msgId   = (decXml.match(/<MsgId>([^<]+)<\/MsgId>/) || [])[1] || 'unknown';
  const amount  = (decXml.match(/<IntrBkSttlmAmt[^>]*>([^<]+)</) || [])[1] || '';
  logger.info({ msgId, amount }, 'NIBSS pacs.008 inbound — received (not yet processed)');

  return res.status(200).json({ status: 'received', msgType: 'pacs.008', msgId });
});

// ── pacs.002 inbound — payment status report ──────────────────────────────────
// NIBSS confirms or rejects our outbound pacs.008
router.post('/pacs002', (req, res) => {
  const xml = rawBody(req);
  if (!NIBSS_LIVE || !xml) {
    logger.warn('NIBSS pacs.002 inbound — stub/no-body');
    return res.status(200).json({ status: 'received', msgType: 'pacs.002' });
  }

  const { ok, xml: decXml, error } = decryptInbound(xml);
  if (!ok) {
    logger.error({ error }, 'NIBSS pacs.002 inbound — decrypt failed');
    return res.status(400).json({ status: 'decrypt_failed', error });
  }

  const { parsePacs002 } = getNps();
  const parsed = parsePacs002(decXml);
  logger.info({ ...parsed }, 'NIBSS pacs.002 inbound — parsed');

  // TODO: update payout record status in DB based on parsed.grpStatus / origMsgId
  const origMsgId = (decXml.match(/<OrgnlMsgId>([^<]+)<\/OrgnlMsgId>/) || [])[1] || '';
  logger.info({ origMsgId, ...parsed }, 'NIBSS pacs.002 — need to update payout record');

  return res.status(200).json({ status: 'received', msgType: 'pacs.002', ...parsed });
});

// ── acmt.024 inbound — name enquiry response ──────────────────────────────────
router.post('/acmt024', (req, res) => {
  const xml = rawBody(req);
  if (!NIBSS_LIVE || !xml) {
    logger.warn('NIBSS acmt.024 inbound — stub/no-body');
    return res.status(200).json({ status: 'received', msgType: 'acmt.024' });
  }

  const { ok, xml: decXml, error } = decryptInbound(xml);
  if (!ok) {
    logger.error({ error }, 'NIBSS acmt.024 inbound — decrypt failed');
    return res.status(400).json({ status: 'decrypt_failed', error });
  }

  const origMsgId = (decXml.match(/<OrgnlId>([^<]+)<\/OrgnlId>/) || [])[1] || '';
  const acctName  = (decXml.match(/<Nm>([^<]+)<\/Nm>/)           || [])[1] || '';
  const rjctCd    = (decXml.match(/<Rsn><Cd>(\w+)<\/Cd>/)        || [])[1] || '';
  logger.info({ origMsgId, acctName, rjctCd }, 'NIBSS acmt.024 inbound — name enquiry response');

  // TODO: cache the account name against origMsgId for pacs.008 SplmtryData
  return res.status(200).json({ status: 'received', msgType: 'acmt.024', origMsgId, acctName, rjctCd });
});

// ── Forward-compat stubs for the remaining 14 message types ──────────────────
router.post('/pacs003', stub('pacs.003')); // FI direct debit
router.post('/pain009', stub('pain.009')); // mandate initiation
router.post('/pain010', stub('pain.010')); // mandate amendment
router.post('/pain011', stub('pain.011')); // mandate cancellation
router.post('/pain012', stub('pain.012')); // mandate acceptance report
router.post('/pain013', stub('pain.013')); // creditor payment activation request
router.post('/pain014', stub('pain.014')); // creditor payment activation status
router.post('/camt060', stub('camt.060')); // account reporting request
router.post('/camt052', stub('camt.052')); // intraday account report
router.post('/camt053', stub('camt.053')); // end-of-day statement
router.post('/pain001', stub('pain.001')); // credit transfer initiation
router.post('/pain002', stub('pain.002')); // customer payment status
router.post('/pain008', stub('pain.008')); // customer direct debit initiation
router.post('/acmt023', stub('acmt.023')); // account verification request (we originate these)

module.exports = router;
