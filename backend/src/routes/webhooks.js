'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { ok, fail } = require('../utils/helpers');

router.get('/', requireAuth, async (req,res,next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res,'No merchant account');
    const deliveries = await prisma.webhookDelivery.findMany({ where:{merchantId}, orderBy:{createdAt:'desc'}, take:50 });
    ok(res, deliveries);
  } catch(e){next(e);}
});

router.put('/config', requireAuth, async (req,res,next) => {
  try {
    const merchantId = req.user.merchant?.id;
    if (!merchantId) return fail(res,'No merchant account');
    const { webhook_url } = req.body;
    await prisma.merchant.update({ where:{id:merchantId}, data:{webhookUrl:webhook_url||null} });
    ok(res,{webhook_url,message:'Webhook URL updated'});
  } catch(e){next(e);}
});

module.exports = router;
