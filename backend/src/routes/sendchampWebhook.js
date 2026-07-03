'use strict';
/**
 * SendChamp webhook — delivery-status callbacks and inbound messages for the
 * WhatsApp/SMS channel. Public (no JWT): SendChamp POSTs here.
 *
 * Configure this URL in the SendChamp dashboard:
 *   https://api.paylodeservices.com/v1/sendchamp/webhook
 *
 * We ACK 200 immediately (so SendChamp doesn't retry) and record the event.
 * Status updates are matched to our outbound sends by SendChamp's message id /
 * reference once the send pipeline is wired (see sendchampService).
 */
const router = require('express').Router();
const { logger } = require('../utils/logger');

// Some providers probe the endpoint with a GET before saving it — answer it.
router.get('/webhook', (req, res) =>
  res.status(200).json({ status: true, message: 'SendChamp webhook is live' }));

router.post('/webhook', (req, res) => {
  // Ack first so a slow handler can never cause SendChamp to retry/timeout.
  res.status(200).json({ status: true });
  try {
    const evt = req.body || {};
    logger.info({
      channel: 'sendchamp',
      event:   evt.event || evt.type || evt.status || 'unknown',
      reference: evt.reference || evt.message_reference || evt.data?.reference || null,
      to:      evt.to || evt.phone_number || evt.data?.to || null,
      raw:     evt,
    }, 'SendChamp webhook event');
  } catch (e) { /* never throw after ack */ }
});

module.exports = router;
