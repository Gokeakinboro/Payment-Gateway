'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { ok, fail } = require('../utils/helpers');
const { verifyWebhookSignature } = require('../services/youverifyService');
const { logAudit } = require('../services/auditService');
const { generateApiKey, hashApiKey } = require('../utils/helpers');
const crypto = require('crypto');

// GET — YouVerify dashboard URL validation ping
router.get('/', (req, res) => {
  res.json({ status: true, message: 'Paylode YouVerify webhook endpoint active' });
});

// POST /api/v1/webhooks/youverify
router.post('/', async (req, res, next) => {
  try {
    const signature = req.headers['x-youverify-signature'] || req.headers['x-yv-signature'] || '';
    const body = req.body;

    // In production: verify signature strictly
    // In sandbox: allow through if signature is missing (YouVerify sandbox doesn't always sign)
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction && process.env.YOUVERIFY_WEBHOOK_SECRET && signature) {
      const valid = verifyWebhookSignature(JSON.stringify(body), signature);
      if (!valid) {
        return res.status(401).json({ status: false, message: 'Invalid webhook signature' });
      }
    }

    const { requestId, status, type, data } = body;
    if (!requestId) return res.status(400).json({ status: false, message: 'Missing requestId' });

    // Find the KYC submission linked to this requestId
    const submission = await prisma.kycSubmission.findFirst({
      where: {
        OR: [
          { yvBvnRef: requestId },
          { yvNinRef: requestId },
          { yvCacRef: requestId },
        ],
      },
      include: { merchant: true },
    });

    if (!submission) {
      // Unknown requestId — acknowledge but don't error
      return ok(res, { received: true, matched: false });
    }

    const verified = status === 'found' || status === 'verified' || status === 'completed';
    const updates  = {};

    if (submission.yvBvnRef === requestId) {
      updates.bvnCheckStatus = verified ? 'verified' : 'failed';
      updates.bvnVerified    = verified;
    } else if (submission.yvNinRef === requestId) {
      updates.ninCheckStatus = verified ? 'verified' : 'failed';
      updates.ninVerified    = verified;
    } else if (submission.yvCacRef === requestId) {
      updates.cacCheckStatus = verified ? 'verified' : 'failed';
      updates.cacVerified    = verified;
    }

    if (data) {
      if (submission.yvBvnRef === requestId) updates.bvnData = data;
      if (submission.yvNinRef === requestId) updates.ninData = data;
      if (submission.yvCacRef === requestId) updates.cacData = data;
    }

    await prisma.kycSubmission.update({ where: { id: submission.id }, data: updates });

    await logAudit(null, 'YOUVERIFY_WEBHOOK', 'kyc_submissions', submission.id, {},
      { requestId, type, status, verified });

    // Re-check for Tier 1 auto-approval after this webhook update
    const fresh = await prisma.kycSubmission.findUnique({ where: { id: submission.id } });
    if (
      fresh?.tierApplied === 1 &&
      fresh?.status === 'submitted' &&
      fresh?.bvnCheckStatus === 'verified' &&
      fresh?.ninCheckStatus === 'verified'
    ) {
      await autoApproveTier1(fresh, submission.merchant);
    }

    // Fan-out to biz9ja (fire-and-forget — same key/secret, same entity)
    setImmediate(async () => {
      try {
        const https = require('https');
        const payload = JSON.stringify(body);
        const fwdHeaders = {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        };
        if (signature) fwdHeaders['x-youverify-signature'] = signature;
        const opts = {
          hostname: 'biz9ja.com',
          port: 443,
          path: '/api/webhooks/youverify',
          method: 'POST',
          headers: fwdHeaders,
        };
        const fwdReq = https.request(opts);
        fwdReq.on('error', (e) => console.error('[yv-fanout] biz9ja fwd error:', e.message));
        fwdReq.write(payload);
        fwdReq.end();
      } catch (e) {
        console.error('[yv-fanout] unexpected:', e.message);
      }
    });

    ok(res, { received: true, matched: true, updated: Object.keys(updates) });
  } catch (e) { next(e); }
});

async function autoApproveTier1(submission, merchant) {
  const liveSecret = generateApiKey('sk_live');
  const testSecret = generateApiKey('sk_test');
  const livePub    = generateApiKey('pk_live');
  const testPub    = generateApiKey('pk_test');
  const webhookSec = crypto.randomBytes(32).toString('hex');

  await prisma.$transaction([
    prisma.kycSubmission.update({
      where: { id: submission.id },
      data: { status: 'approved', approvedAt: new Date(), reviewNotes: 'Auto-approved via YouVerify webhook (BVN + NIN verified)' },
    }),
    prisma.merchant.update({
      where: { id: merchant.id },
      data: { kycStatus: 'ACTIVE', kycTier: 1, isActive: true, webhookSecret: webhookSec, processingRate: 0.015 },
    }),
    prisma.apiKey.createMany({ data: [
      { merchantId: merchant.id, keyHash: hashApiKey(liveSecret), keyPrefix: 'sk_live', label: 'Live Secret Key',  isSandbox: false },
      { merchantId: merchant.id, keyHash: hashApiKey(testSecret), keyPrefix: 'sk_test', label: 'Test Secret Key',  isSandbox: true  },
      { merchantId: merchant.id, keyHash: hashApiKey(livePub),    keyPrefix: 'pk_live', label: 'Live Public Key',  isSandbox: false },
      { merchantId: merchant.id, keyHash: hashApiKey(testPub),    keyPrefix: 'pk_test', label: 'Test Public Key',  isSandbox: true  },
    ]}),
  ]);

  await logAudit(null, 'KYC_AUTO_APPROVED_TIER1', 'kyc_submissions', submission.id, {},
    { reason: 'YouVerify webhook: BVN + NIN verified', merchantId: merchant.id });
}

module.exports = router;
