'use strict';
const router = require('express').Router();
const { prisma } = require('../utils/db');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { ok, fail, created, notFound } = require('../utils/helpers');

router.get('/', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try { ok(res, await prisma.emailTemplate.findMany({ orderBy:{ name:'asc' } })); } catch(e){next(e);}
});

router.get('/:id', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const t = await prisma.emailTemplate.findUnique({ where:{ id:req.params.id } });
    t ? ok(res,t) : notFound(res,'Template');
  } catch(e){next(e);}
});

router.post('/', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { slug, name, subject, htmlBody, variables } = req.body;
    if (!slug||!name||!subject||!htmlBody) return fail(res,'slug, name, subject, htmlBody required');
    if (await prisma.emailTemplate.findUnique({ where:{slug} })) return fail(res,'Slug already exists');
    created(res, await prisma.emailTemplate.create({ data:{ slug, name, subject, htmlBody, variables:variables||[], isSystem:false } }), 'Template created');
  } catch(e){next(e);}
});

router.patch('/:id', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { name, subject, htmlBody, variables, isActive } = req.body;
    const data = {};
    if (name!==undefined)      data.name=name;
    if (subject!==undefined)   data.subject=subject;
    if (htmlBody!==undefined)  data.htmlBody=htmlBody;
    if (variables!==undefined) data.variables=variables;
    if (isActive!==undefined)  data.isActive=isActive;
    ok(res, await prisma.emailTemplate.update({ where:{id:req.params.id}, data }), 'Saved');
  } catch(e){next(e);}
});

router.delete('/:id', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const t = await prisma.emailTemplate.findUnique({ where:{id:req.params.id} });
    if (!t) return notFound(res,'Template');
    if (t.isSystem) return fail(res,'System templates cannot be deleted. Deactivate instead.');
    await prisma.emailTemplate.delete({ where:{id:req.params.id} });
    ok(res,null,'Deleted');
  } catch(e){next(e);}
});

router.post('/:id/preview', requireAuth, requireSuperAdmin, async (req,res,next) => {
  try {
    const { to } = req.body;
    if (!to) return fail(res,'to email required');
    const t = await prisma.emailTemplate.findUnique({ where:{id:req.params.id} });
    if (!t) return notFound(res,'Template');
    const { sendEmail } = require('../services/emailService');
    const html    = t.htmlBody.replace(/\{\{[^}]+\}\}/g,'[sample_value]');
    const subject = t.subject.replace(/\{\{[^}]+\}\}/g,'[sample]') + ' [PREVIEW]';
    await sendEmail({ to, subject, html });
    ok(res,null,'Preview sent to ' + to);
  } catch(e){next(e);}
});

module.exports = router;
