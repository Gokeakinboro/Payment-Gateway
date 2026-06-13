'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const IORedis    = require('ioredis');
const { Worker } = require('bullmq');
const { prisma } = require('../utils/db');
const { signWebhook } = require('../utils/helpers');
const { logger } = require('../utils/logger');

const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck:     false,
});

const worker = new Worker('webhook-deliveries', async (job) => {
  const { merchantId, event, payload, url, secret } = job.data;
  const startMs    = Date.now();
  const body       = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
  const signature  = signWebhook(body, secret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':        'application/json',
        'X-Paylode-Signature': signature,
        'X-Paylode-Event':     event,
        'User-Agent':          'Paylode-Webhooks/1.0',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const responseMs = Date.now() - startMs;
    const success    = resp.ok;

    await prisma.webhookDelivery.create({ data: {
      merchantId, event, payload, url,
      responseCode: resp.status,
      responseMs,
      attempt: (job.attemptsMade ?? 0) + 1,
      success,
    }}).catch(() => {});

    if (!success) throw new Error(`HTTP ${resp.status} from ${url}`);

    logger.info({ event, url, attempt: (job.attemptsMade ?? 0) + 1, responseMs }, 'Webhook delivered');
  } catch(e) {
    clearTimeout(timer);

    // Log failed attempt to DB
    await prisma.webhookDelivery.create({ data: {
      merchantId, event, payload, url,
      responseMs: Date.now() - startMs,
      attempt: (job.attemptsMade ?? 0) + 1,
      success: false,
    }}).catch(() => {});

    throw e; // Let BullMQ handle retry backoff
  }
}, {
  connection,
  concurrency: 5,
  limiter: { max: 50, duration: 1000 },  // max 50 deliveries/sec
});

worker.on('completed', job => {
  logger.debug({ jobId: job.id, event: job.data.event }, 'Webhook job completed');
});

worker.on('failed', (job, err) => {
  const attemptsLeft = (job?.opts?.attempts ?? 3) - ((job?.attemptsMade ?? 0) + 1);
  logger.warn({
    jobId:       job?.id,
    event:       job?.data?.event,
    url:         job?.data?.url,
    attemptsMade: job?.attemptsMade,
    attemptsLeft,
    err:         err.message,
  }, attemptsLeft > 0 ? 'Webhook failed — will retry' : 'Webhook permanently failed');
});

worker.on('error', err => logger.error({ err }, 'Webhook worker error'));

logger.info({ concurrency: 5 }, 'Paylode webhook worker started');

async function shutdown() {
  logger.info('Webhook worker shutting down...');
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
