'use strict';
/**
 * WhatsApp (Meta Cloud API) webhook — delivery statuses + inbound messages.
 *
 * Configure in the Meta App dashboard → WhatsApp → Configuration:
 *   Callback URL:  https://api.paylodeservices.com/v1/whatsapp/webhook
 *   Verify token:  value of WHATSAPP_WEBHOOK_VERIFY_TOKEN (we generate it)
 *
 * GET  = Meta's verification handshake (echo hub.challenge when the token matches).
 * POST = events; we ACK 200 immediately and log. Optional X-Hub-Signature-256
 *        check against WHATSAPP_APP_SECRET when the raw body is available.
 */
const crypto = require('crypto');
const router = require('express').Router();
const { logger } = require('../utils/logger');

const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
const APP_SECRET   = process.env.WHATSAPP_APP_SECRET || '';

// Verification handshake — Meta calls this once when you save the callback URL.
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(String(challenge == null ? '' : challenge));
  }
  return res.sendStatus(403);
});

router.post('/webhook', (req, res) => {
  // Ack first so a slow handler can never cause Meta to retry/disable the webhook.
  res.sendStatus(200);
  try {
    // Best-effort signature check (only when we have both the secret and raw body).
    if (APP_SECRET && req.rawBody) {
      const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
      const got = req.get('x-hub-signature-256') || '';
      if (got && got.length === expected.length && !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        logger.warn({ channel: 'whatsapp' }, 'WhatsApp webhook signature mismatch');
        return;
      }
    }
    const entry = (req.body && req.body.entry) || [];
    for (const e of entry) {
      for (const ch of (e.changes || [])) {
        const v = ch.value || {};
        (v.statuses || []).forEach((s) =>
          logger.info({ channel: 'whatsapp', kind: 'status', id: s.id, status: s.status, to: s.recipient_id }, 'WhatsApp status'));
        (v.messages || []).forEach((m) =>
          logger.info({ channel: 'whatsapp', kind: 'inbound', from: m.from, type: m.type }, 'WhatsApp inbound'));
      }
    }
  } catch (e) { /* never throw after ack */ }
});

module.exports = router;
