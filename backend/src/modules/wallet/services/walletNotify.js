'use strict';
/**
 * Wallet notifications — email (live) + WhatsApp (best-effort, no-ops until a
 * WHATSAPP_TEMPLATE_WALLET is configured). Best-effort and never throws; callers
 * fire-and-forget so money operations are never blocked by a notification.
 */
const { prisma, getConfig, normalizePhone } = require('../_shared');
const { sendEmail } = require('../../../services/emailService');
const whatsapp = require('../../../services/whatsappService');

const ngn = (kobo) => '₦' + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

async function send({ merchantId, to, phone, name, subject, lines, waParams }) {
  try {
    const cfg = await getConfig(merchantId);
    const brand = cfg.brand_name || 'Your wallet';
    if (cfg.notify_email && to) {
      const body = lines.map((l) => `<p style="margin:6px 0">${l}</p>`).join('');
      sendEmail({
        to, subject: `${brand}: ${subject}`,
        html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:480px;color:#222"><p>Hi ${name || 'there'},</p>${body}<p style="font-size:11px;color:#999;margin-top:16px">${brand}</p></div>`,
        text: `Hi ${name || 'there'},\n${lines.map((l) => l.replace(/<[^>]+>/g, '')).join('\n')}\n${brand}`,
      }).catch(() => {});
    }
    if (cfg.notify_whatsapp && phone) {
      // Generic wallet template (config-gated in whatsappService; no-ops until set).
      whatsapp.sendTemplate(normalizePhone(phone), process.env.WHATSAPP_TEMPLATE_WALLET || '',
        process.env.WHATSAPP_TEMPLATE_WALLET_LANG || 'en', waParams || []).catch(() => {});
    }
  } catch (e) { /* never throw */ }
}

// Resolve a member's contact + low-balance threshold + new balance, for member-facing alerts.
async function memberFunded(walletId, amount, balanceAfter) {
  const r = (await prisma.$queryRawUnsafe(
    `SELECT m.id::text AS member_id, m.merchant_id::text AS merchant_id, m.name, m.email, m.phone FROM mw_wallets w JOIN mw_members m ON m.id=w.member_id WHERE w.id=$1::uuid`, walletId))[0];
  if (!r) return;
  await send({ merchantId: r.merchant_id, to: r.email, phone: r.phone, name: r.name,
    subject: 'Wallet funded', lines: [`Your wallet was funded with <strong>${ngn(amount)}</strong>.`, `New balance: <strong>${ngn(balanceAfter)}</strong>.`],
    waParams: [r.name || 'there', ngn(amount), ngn(balanceAfter)] });
  require('./walletPush').sendToMember(r.member_id, { title: 'Wallet funded', body: `${ngn(amount)} added — balance ${ngn(balanceAfter)}.`, url: '/wallet.html' }).catch(() => {});
}

// Member spent into a department — notify the member AND the department sub-user(s).
async function memberSpent({ merchantId, walletId, departmentId, amount, balanceAfter }) {
  const m = (await prisma.$queryRawUnsafe(
    `SELECT mm.id::text AS member_id, name, email, phone, low_balance_threshold::text AS lbt FROM mw_wallets w JOIN mw_members mm ON mm.id=w.member_id WHERE w.id=$1::uuid`, walletId))[0];
  let deptName = 'a department';
  if (departmentId) {
    const d = (await prisma.$queryRawUnsafe(`SELECT name FROM inv_departments WHERE id=$1::uuid`, departmentId))[0];
    if (d) deptName = d.name;
    const subs = await prisma.$queryRawUnsafe(`SELECT name, email, phone FROM inv_department_users WHERE department_id=$1::uuid`, departmentId);
    for (const s of subs)
      await send({ merchantId, to: s.email, phone: s.phone, name: s.name, subject: `Payment to ${deptName}`,
        lines: [`${m ? m.name : 'A member'} paid <strong>${ngn(amount)}</strong> to ${deptName}.`], waParams: [s.name || 'there', ngn(amount), deptName] });
  }
  if (m) {
    await send({ merchantId, to: m.email, phone: m.phone, name: m.name, subject: `Payment to ${deptName}`,
      lines: [`You paid <strong>${ngn(amount)}</strong> to ${deptName}.`, `Wallet balance: <strong>${ngn(balanceAfter)}</strong>.`],
      waParams: [m.name || 'there', ngn(amount), deptName] });
    require('./walletPush').sendToMember(m.member_id, { title: `Paid ${ngn(amount)}`, body: `To ${deptName} — balance ${ngn(balanceAfter)}.`, url: '/wallet.html' }).catch(() => {});
    if (m.lbt && BigInt(m.lbt) > 0n && BigInt(balanceAfter) < BigInt(m.lbt))
      await send({ merchantId, to: m.email, phone: m.phone, name: m.name, subject: 'Low wallet balance',
        lines: [`Your wallet balance is low: <strong>${ngn(balanceAfter)}</strong>.`, `Top up to keep transacting.`], waParams: [m.name || 'there', ngn(balanceAfter)] });
  }
}

module.exports = { memberFunded, memberSpent, send };
