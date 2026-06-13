'use strict';
const IORedis    = require('ioredis');
const { Queue }  = require('bullmq');
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');
const { signWebhook } = require('../utils/helpers');

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
});

const webhookQueue = new Queue('webhook-deliveries', { connection });

async function dispatchWebhook(merchantId, event, payload) {
  try {
    const merchant = await prisma.merchant.findUnique({
      where:  { id: merchantId },
      select: { webhookUrl: true, webhookSecret: true },
    });
    if (!merchant?.webhookUrl) return;

    await webhookQueue.add('deliver', {
      merchantId,
      event,
      payload,
      url:    merchant.webhookUrl,
      secret: merchant.webhookSecret || '',
    }, {
      attempts: 3,
      backoff:  { type: 'exponential', delay: 10000 },  // 10s → 20s → 40s
      removeOnComplete: { count: 500 },
      removeOnFail:     { count: 500 },
    });

    logger.info({ merchantId, event }, 'Webhook queued');
  } catch(e) {
    logger.error({ err: e, merchantId, event }, 'Failed to enqueue webhook');
  }
}

module.exports = { dispatchWebhook, webhookQueue };
