'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin, requireCompliance } = require('../middleware/auth');
const { ok, fail, notFound, koboToNaira, generateApiKey, hashApiKey } = require('../utils/helpers');
const { logAudit } = require('../services/auditService');



router.get('/', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role === 'MERCHANT') {
      const m = await prisma.merchant.findUnique({ where:{ id: req.user.merchant.id }, include:{ aggregator:{select:{companyName:true}} } });
      return ok(res, m);
    }
    const { page=1, perPage=20, kycStatus, aggregatorId } = req.query;
    const where = {};
    if (kycStatus)    where.kycStatus    = kycStatus;
    if (aggregatorId) where.aggregatorId = aggregatorId;
    const [data, total] = await Promise.all([
      prisma.merchant.findMany({ where, skip:(parseInt(page)-1)*parseInt(perPage), take:parseInt(perPage), orderBy:{createdAt:'desc'}, include:{aggregator:{select:{companyName:true}}} }),
      prisma.merchant.count({ where }),
    ]);
    ok(res, { data, meta:{ total, page:parseInt(page), pages:Math.ceil(total/parseInt(perPage)) } });
  } catch (e) { next(e); }
});

router.put('/:id/rate', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rate = parseFloat(req.body.processing_rate);
    if (isNaN(rate) || rate < 0 || rate > 0.1) return fail(res, 'processing_rate must be between 0 and 0.1');
    const before = await prisma.merchant.findUnique({ where:{id:req.params.id}, select:{processingRate:true} });
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{processingRate:rate} });
    await logAudit(req.user.id, 'RATE_CHANGED', 'merchants', m.id, {processingRate:before?.processingRate}, {processingRate:rate}, req.body.notes);
    ok(res, { merchant_id:m.id, processing_rate:Number(m.processingRate) });
  } catch (e) { next(e); }
});

router.put('/:id/suspend', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'SUSPENDED',isActive:false} });
    await logAudit(req.user.id, 'MERCHANT_SUSPENDED', 'merchants', m.id, {isActive:true}, {isActive:false}, req.body.reason);
    ok(res, { message:'Merchant suspended' });
  } catch (e) { next(e); }
});

router.put('/:id/activate', requireAuth, requireCompliance, async (req, res, next) => {
  try {
    const m = await prisma.merchant.update({ where:{id:req.params.id}, data:{kycStatus:'ACTIVE',isActive:true} });
    await logAudit(req.user.id, 'MERCHANT_REACTIVATED', 'merchants', m.id, {isActive:false}, {isActive:true});
    ok(res, { message:'Merchant reactivated' });
  } catch (e) { next(e); }
});

router.get('/:id/api-keys', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role==='MERCHANT' ? req.user.merchant.id : req.params.id;
    const keys = await prisma.apiKey.findMany({ where:{merchantId,isActive:true}, select:{id:true,keyPrefix:true,label:true,isSandbox:true,lastUsedAt:true,createdAt:true}, orderBy:{createdAt:'desc'} });
    ok(res, keys);
  } catch (e) { next(e); }
});

router.post('/:id/api-keys/rotate', requireAuth, async (req, res, next) => {
  try {
    const merchantId = req.user.role==='MERCHANT' ? req.user.merchant.id : req.params.id;
    const { prefix } = req.body;
    if (!prefix) return fail(res, 'prefix required');
    await prisma.apiKey.updateMany({ where:{merchantId,keyPrefix:prefix}, data:{isActive:false} });
    const newKey = generateApiKey(prefix);
    await prisma.apiKey.create({ data:{ merchantId, keyHash:hashApiKey(newKey), keyPrefix:prefix, label:req.body.label||'Rotated Key', isSandbox:prefix.includes('test') } });
    ok(res, { key:newKey, prefix, message:'Key rotated. Save this — it will not be shown again.' });
  } catch (e) { next(e); }
});

module.exports = router;
