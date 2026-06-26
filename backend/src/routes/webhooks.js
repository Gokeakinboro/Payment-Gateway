'use strict';
const router = require('express').Router();
const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const { prisma } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/helpers');

// ── GET /api/v1/webhooks/config ───────────────────────────────────────────────
router.get('/config', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const m = await prisma.merchant.findUnique({ where:{ id: merchantId }, select:{ webhookUrl:true } });
    ok(res, {
      webhook_url: m?.webhookUrl || null,
      events: ['payment.success','payment.failed','payment.pending','refund.processed','settlement.completed','chargeback.created'],
    });
  } catch(e){ next(e); }
});

// ── PUT /api/v1/webhooks/config ───────────────────────────────────────────────
router.put('/config', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const { webhook_url } = req.body;
    if (webhook_url) {
      try { new URL(webhook_url); } catch { return fail(res, 'Invalid URL format'); }
      if (!webhook_url.startsWith('https://')) return fail(res, 'Webhook URL must use HTTPS');
    }
    await prisma.merchant.update({ where:{ id: merchantId }, data:{ webhookUrl: webhook_url || null } });
    ok(res, { webhook_url: webhook_url || null, message: 'Webhook endpoint updated' });
  } catch(e){ next(e); }
});

// ── POST /api/v1/webhooks/test ────────────────────────────────────────────────
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const m = await prisma.merchant.findUnique({ where:{ id: merchantId }, select:{ webhookUrl:true, merchantCode:true } });
    if (!m?.webhookUrl) return fail(res, 'No webhook URL configured. Add an endpoint first.');

    const payload = JSON.stringify({
      event: 'payment.success',
      data: {
        reference: 'TEST-' + Date.now(),
        amount:    500000,
        currency:  'NGN',
        status:    'SUCCESS',
        channel:   'CARD',
        merchant:  m.merchantCode,
        customer:  { email: 'test@example.com' },
        paid_at:   new Date().toISOString(),
        is_test:   true,
      },
    });

    const targetUrl = new URL(m.webhookUrl);
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path:     targetUrl.pathname + (targetUrl.search || ''),
      method:   'POST',
      headers:  {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(payload),
        'X-Paylode-Event': 'payment.success',
        'X-Paylode-Test':  '1',
      },
    };

    await new Promise((resolve) => {
      const t0 = Date.now();
      const reqH = lib.request(options, (httpRes) => {
        let body = '';
        httpRes.on('data', d => body += d);
        httpRes.on('end', () => {
          ok(res, {
            success:     httpRes.statusCode >= 200 && httpRes.statusCode < 300,
            status_code: httpRes.statusCode,
            duration_ms: Date.now() - t0,
            response:    body.slice(0, 500),
            url:         m.webhookUrl,
          });
          resolve();
        });
      });
      reqH.on('error', (err) => { ok(res, { success: false, error: err.message, url: m.webhookUrl }); resolve(); });
      reqH.setTimeout(10000, () => { reqH.destroy(); ok(res, { success: false, error: 'Timed out after 10s', url: m.webhookUrl }); resolve(); });
      reqH.write(payload);
      reqH.end();
    });
  } catch(e){ next(e); }
});

// ── GET /api/v1/webhooks (delivery history) ───────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res, 'No merchant account');
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    ok(res, deliveries);
  } catch(e){ next(e); }
});

module.exports = router;
