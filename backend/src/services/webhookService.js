'use strict';
const { prisma }          = require('../utils/db');
const { logger }          = require('../utils/logger');
const { signWebhook }     = require('../utils/helpers');

async function dispatchWebhook(merchantId, event, payload, attempt = 1) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { webhookUrl: true, webhookSecret: true },
  });
  if (!merchant?.webhookUrl) return;

  const body      = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
  const signature = signWebhook(body, merchant.webhookSecret);
  const start     = Date.now();

  try {
    const resp = await fetch(merchant.webhookUrl, {
      method:  'POST',
      headers: {
        'Content-Type':        'application/json',
        'X-Paylode-Signature': signature,
        'X-Paylode-Event':     event,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    await prisma.webhookDelivery.create({ data: {
      merchantId, event, payload, url: merchant.webhookUrl,
      responseCode: resp.status, responseMs: Date.now() - start,
      attempt, success: resp.ok,
    }});

    if (!resp.ok && attempt < 3) {
      const delay = attempt * 30000;
      logger.warn({ merchantId, event, status: resp.status, attempt }, `Webhook failed, retrying in ${delay}ms`);
      setTimeout(() => dispatchWebhook(merchantId, event, payload, attempt + 1), delay);
    }
  } catch (e) {
    await prisma.webhookDelivery.create({ data: {
      merchantId, event, payload, url: merchant.webhookUrl,
      responseMs: Date.now() - start, attempt, success: false,
    }}).catch(() => {});

    if (attempt < 3) {
      setTimeout(() => dispatchWebhook(merchantId, event, payload, attempt + 1), attempt * 30000);
    }
    logger.error({ err: e, merchantId, event }, 'Webhook dispatch error');
  }
}

module.exports = { dispatchWebhook };
