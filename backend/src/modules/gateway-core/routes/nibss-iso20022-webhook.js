'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  NIBSS ISO 20022 inbound webhooks
//
//  nginx on 176 routes 443/nps/* → :3000/api/v1/webhooks/nibss/*
//
//  All routes return HTTP 200 — NIBSS retries on any non-200 response.
//
//  Critical paths:
//    POST /pacs008 — inbound credit transfer (NIBSS sends money to us)
//    POST /pacs002 — status report for our outbound pacs.008 (payout result)
//    POST /acmt023 — NE request to us (we respond with acmt.024 account name)
//    POST /acmt024 — async NE response for our outbound acmt.023
// ─────────────────────────────────────────────────────────────────────────────
const router     = require('express').Router();
const { logger } = require('../../../utils/logger');
const { prisma } = require('../../../utils/db');

const NIBSS_LIVE = process.env.NIBSS_NPS_ENABLED === 'true';

let nps = null;
function getNps() {
  if (!nps) nps = require('../services/nibssNpsService');
  return nps;
}

function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string' && req.body.length > 0) return req.body;
  return '';
}

function decryptInbound(xml) {
  try {
    if (!xml || !xml.includes('<xenc:EncryptedData')) return { ok: true, xml };
    const { decryptContentElement } = getNps();
    return { ok: true, xml: decryptContentElement(xml) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── pacs.008 inbound — credit transfer FROM NIBSS ────────────────────────────
// NIBSS sends us money; we decrypt, ACK with pacs.002 ACCP, log for reconciliation.
// Actual merchant crediting is wired separately once inbound VA mapping is defined.
router.post('/pacs008', async (req, res) => {
  const raw = rawBody(req);
  logger.info({ xmlLen: raw.length }, 'NIBSS pacs.008 inbound');

  if (!NIBSS_LIVE || !raw) {
    return res.status(200).json({ status: 'received', msgType: 'pacs.008' });
  }

  const { ok, xml: decXml, error } = decryptInbound(raw);
  if (!ok) {
    logger.error({ error }, 'NIBSS pacs.008 inbound — decrypt failed');
    // Still 200 — do not trigger NIBSS retry on decrypt failures
    return res.status(200).json({ status: 'decrypt_failed' });
  }

  const { parsePacs008Inbound, sendPacs002 } = getNps();
  const parsed = parsePacs008Inbound(decXml);
  logger.info({ ...parsed }, 'NIBSS pacs.008 inbound — parsed');

  // Attempt to match by creditor account in transaction metadata
  if (parsed.creditorAccount) {
    try {
      const txn = await prisma.transaction.findFirst({
        where: {
          status:   'PENDING',
          metadata: { path: ['nps_va_no'], equals: parsed.creditorAccount },
        },
        select: { reference: true },
        orderBy: { createdAt: 'desc' },
      });
      if (txn) {
        // TODO: wire finalizePayinSuccess when inbound NPS VA flow is fully defined
        logger.info({ reference: txn.reference, ...parsed },
          'NIBSS pacs.008 inbound — matched pending txn (crediting not yet wired)');
      } else {
        logger.warn({ creditorAccount: parsed.creditorAccount, amountKobo: parsed.amountKobo },
          'NIBSS pacs.008 inbound — no matching pending txn; logged for reconciliation');
      }
    } catch (e) {
      logger.warn({ error: e.message }, 'NIBSS pacs.008 inbound — DB lookup failed');
    }
  }

  // Always ACK with pacs.002 ACCP — NIBSS spec requires this
  try {
    await sendPacs002({ origMsgId: parsed.msgId, origTxId: parsed.txId, grpStatus: 'ACCP' });
  } catch (e) {
    logger.warn({ error: e.message }, 'NIBSS pacs.008 inbound — pacs.002 ACK failed (non-fatal)');
  }

  return res.status(200).json({ status: 'received', msgType: 'pacs.008', msgId: parsed.msgId });
});

// ── pacs.002 inbound — payment status for our outbound pacs.008 ──────────────
// NIBSS confirms (ACSC) or rejects (RJCT) a payout we sent.
// Updates payout_items and rail_disbursements by provider_ref = origMsgId.
router.post('/pacs002', async (req, res) => {
  const raw = rawBody(req);
  logger.info({ xmlLen: raw.length }, 'NIBSS pacs.002 inbound');

  if (!NIBSS_LIVE || !raw) {
    return res.status(200).json({ status: 'received', msgType: 'pacs.002' });
  }

  const { ok, xml: decXml, error } = decryptInbound(raw);
  if (!ok) {
    logger.error({ error }, 'NIBSS pacs.002 inbound — decrypt failed');
    return res.status(200).json({ status: 'decrypt_failed' });
  }

  const { parsePacs002 } = getNps();
  const parsed    = parsePacs002(decXml);
  const origMsgId = (decXml.match(/<OrgnlMsgId>([^<]+)<\/OrgnlMsgId>/) || [])[1] || '';
  logger.info({ origMsgId, ...parsed }, 'NIBSS pacs.002 inbound — parsed');

  if (origMsgId) {
    const newStatus = (parsed.grpStatus === 'ACSC' || parsed.txStatus === 'ACSC') ? 'success'
                    : (parsed.grpStatus === 'RJCT' || parsed.txStatus === 'RJCT') ? 'failed'
                    : 'processing';
    try {
      await prisma.$executeRaw`
        UPDATE payout_items
        SET    status       = ${newStatus},
               processed_at = NOW(),
               updated_at   = NOW()
        WHERE  provider_ref = ${origMsgId}
          AND  status NOT IN ('success', 'failed', 'refunded')
      `;
      if (newStatus === 'success') {
        await prisma.$executeRaw`
          UPDATE rail_disbursements
          SET    status     = 'success',
                 settled_at = NOW(),
                 updated_at = NOW()
          WHERE  rail_order_id = ${origMsgId}
            AND  status <> 'success'
        `;
      } else if (newStatus === 'failed') {
        await prisma.$executeRaw`
          UPDATE rail_disbursements
          SET    status     = 'failed',
                 error_msg  = ${parsed.rejectCode || 'NPS RJCT'},
                 updated_at = NOW()
          WHERE  rail_order_id = ${origMsgId}
            AND  status <> 'failed'
        `;
      }
      logger.info({ origMsgId, newStatus }, 'NIBSS pacs.002 inbound — payout status updated');
    } catch (e) {
      logger.error({ error: e.message, origMsgId }, 'NIBSS pacs.002 inbound — DB update failed');
    }
  }

  return res.status(200).json({ status: 'received', msgType: 'pacs.002', origMsgId, ...parsed });
});

// ── acmt.023 inbound — NE request FROM NIBSS (querying one of our accounts) ──
// Another NPS member queries an account we hold. We respond with acmt.024.
router.post('/acmt023', async (req, res) => {
  const raw = rawBody(req);
  logger.info({ xmlLen: raw.length }, 'NIBSS acmt.023 inbound');

  if (!NIBSS_LIVE || !raw) {
    return res.status(200).json({ status: 'received', msgType: 'acmt.023' });
  }

  const { ok, xml: decXml, error } = decryptInbound(raw);
  if (!ok) {
    logger.error({ error }, 'NIBSS acmt.023 inbound — decrypt failed');
    return res.status(200).json({ status: 'decrypt_failed' });
  }

  const { parseAcmt023, sendAcmt024 } = getNps();
  const parsed = parseAcmt023(decXml);
  logger.info({ ...parsed }, 'NIBSS acmt.023 inbound — parsed');

  let accountName = null;
  let rejectCode  = null;

  const DEBIT_ACCOUNT = process.env.NIBSS_NPS_DEBIT_ACCOUNT || '';
  if (parsed.accountNumber && parsed.accountNumber === DEBIT_ACCOUNT) {
    accountName = process.env.NIBSS_NPS_INSTITUTION_NAME || 'PAYLODE SERVICES LIMITED';
  } else if (parsed.accountNumber) {
    try {
      const rows = await prisma.$queryRaw`
        SELECT mva.va_name, m.business_name
        FROM   merchant_virtual_accounts mva
        JOIN   merchants m ON m.id = mva.merchant_id
        WHERE  mva.va_number = ${parsed.accountNumber}
          AND  mva.status    = 'active'
        LIMIT  1
      `;
      if (rows.length > 0) {
        accountName = rows[0].va_name || rows[0].business_name || null;
      }
      if (!accountName) rejectCode = 'AC01';
    } catch (e) {
      logger.warn({ error: e.message }, 'NIBSS acmt.023 inbound — account lookup failed');
      rejectCode = 'AC01';
    }
  } else {
    rejectCode = 'AC03';
  }

  try {
    await sendAcmt024({
      origMsgId:         parsed.msgId,
      requesterMemberId: parsed.requesterMemberId,
      accountNumber:     parsed.accountNumber,
      accountName:       accountName || '',
      status:            rejectCode ? 'RJCT' : 'ACCP',
      rejectCode,
    });
  } catch (e) {
    logger.warn({ error: e.message }, 'NIBSS acmt.023 inbound — acmt.024 send failed (non-fatal)');
  }

  return res.status(200).json({ status: 'received', msgType: 'acmt.023', origMsgId: parsed.msgId });
});

// ── acmt.024 inbound — async NE response for our outbound acmt.023 ────────────
router.post('/acmt024', (req, res) => {
  const raw = rawBody(req);
  if (!NIBSS_LIVE || !raw) return res.status(200).json({ status: 'received', msgType: 'acmt.024' });

  const { ok, xml: decXml } = decryptInbound(raw);
  if (!ok) return res.status(200).json({ status: 'decrypt_failed' });

  const origMsgId = (decXml.match(/<OrgnlId>([^<]+)<\/OrgnlId>/)   || [])[1] || '';
  const acctName  = (decXml.match(/<Nm>([^<]+)<\/Nm>/)              || [])[1] || '';
  const rjctCd    = (decXml.match(/<Rsn><Cd>(\w+)<\/Cd>/)           || [])[1] || '';
  logger.info({ origMsgId, acctName, rjctCd }, 'NIBSS acmt.024 inbound — async NE response');
  return res.status(200).json({ status: 'received', msgType: 'acmt.024', origMsgId, acctName, rjctCd });
});

// ── pacs.028 inbound — NIBSS queries status of one of our payouts ─────────────
router.post('/pacs028', (req, res) => {
  const raw = rawBody(req);
  if (!NIBSS_LIVE || !raw) return res.status(200).json({ status: 'received', msgType: 'pacs.028' });

  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) {
    const origMsgId = (decXml.match(/<OrgnlMsgId>([^<]+)<\/OrgnlMsgId>/) || [])[1] || '';
    logger.info({ origMsgId }, 'NIBSS pacs.028 inbound — payout status query');
    // TODO: respond with current payout status via pacs.002
  }
  return res.status(200).json({ status: 'received', msgType: 'pacs.028' });
});

// ── pacs.003 inbound — direct debit FROM another NPS member ──────────────────
router.post('/pacs003', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) {
    const msgId = (decXml.match(/<MsgId>([^<]+)<\/MsgId>/) || [])[1] || '';
    logger.info({ msgId }, 'NIBSS pacs.003 inbound — direct debit (log-only)');
  }
  return res.status(200).json({ status: 'received', msgType: 'pacs.003' });
});

// ── pain.001 inbound — customer credit transfer initiation ───────────────────
router.post('/pain001', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.001 inbound');
  return res.status(200).json({ status: 'received', msgType: 'pain.001' });
});

// ── pain.002 inbound — customer payment status report ────────────────────────
router.post('/pain002', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.002 inbound');
  return res.status(200).json({ status: 'received', msgType: 'pain.002' });
});

// ── pain.008 inbound — customer direct debit initiation ──────────────────────
router.post('/pain008', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.008 inbound');
  return res.status(200).json({ status: 'received', msgType: 'pain.008' });
});

// ── pain.009 inbound — mandate initiation request ────────────────────────────
router.post('/pain009', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.009 inbound — mandate initiation');
  return res.status(200).json({ status: 'received', msgType: 'pain.009' });
});

// ── pain.010 inbound — mandate amendment request ─────────────────────────────
router.post('/pain010', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.010 inbound — mandate amendment');
  return res.status(200).json({ status: 'received', msgType: 'pain.010' });
});

// ── pain.011 inbound — mandate cancellation request ──────────────────────────
router.post('/pain011', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.011 inbound — mandate cancellation');
  return res.status(200).json({ status: 'received', msgType: 'pain.011' });
});

// ── pain.012 inbound — mandate acceptance report ─────────────────────────────
router.post('/pain012', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.012 inbound — mandate acceptance');
  return res.status(200).json({ status: 'received', msgType: 'pain.012' });
});

// ── pain.013 inbound — creditor payment activation request ───────────────────
router.post('/pain013', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.013 inbound — creditor activation req');
  return res.status(200).json({ status: 'received', msgType: 'pain.013' });
});

// ── pain.014 inbound — creditor payment activation status ────────────────────
router.post('/pain014', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS pain.014 inbound — creditor activation status');
  return res.status(200).json({ status: 'received', msgType: 'pain.014' });
});

// ── camt.060 inbound — account reporting request ─────────────────────────────
router.post('/camt060', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS camt.060 inbound — account reporting request');
  // TODO: respond with camt.052 (intraday) or camt.053 (statement)
  return res.status(200).json({ status: 'received', msgType: 'camt.060' });
});

// ── camt.052 inbound — bank-to-customer intraday report ──────────────────────
router.post('/camt052', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS camt.052 inbound');
  return res.status(200).json({ status: 'received', msgType: 'camt.052' });
});

// ── camt.053 inbound — bank-to-customer end-of-day statement ─────────────────
router.post('/camt053', (req, res) => {
  const raw = rawBody(req);
  const { ok, xml: decXml } = decryptInbound(raw);
  if (ok && decXml) logger.info({ xmlLen: raw.length }, 'NIBSS camt.053 inbound');
  return res.status(200).json({ status: 'received', msgType: 'camt.053' });
});

// Reachability check for browser/plain-GET probes; real NIBSS traffic is POST.
router.get('/:msgType', (req, res) => {
  res.status(200).json({ status: 'ok', endpoint: req.params.msgType, note: 'POST ISO 20022 messages to this URL' });
});

module.exports = router;
