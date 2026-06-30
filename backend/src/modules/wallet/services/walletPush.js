'use strict';
/**
 * Web-push for the member wallet PWA. Best-effort, never throws. No-ops unless
 * WALLET_VAPID_PUBLIC/PRIVATE are configured. Dead subscriptions (404/410) are
 * pruned automatically so the table stays clean.
 */
const { prisma } = require('../_shared');

let webpush = null, ready = false;
try {
  webpush = require('web-push');
  if (process.env.WALLET_VAPID_PUBLIC && process.env.WALLET_VAPID_PRIVATE) {
    webpush.setVapidDetails(
      process.env.WALLET_VAPID_SUBJECT || 'mailto:support@paylodeservices.com',
      process.env.WALLET_VAPID_PUBLIC, process.env.WALLET_VAPID_PRIVATE);
    ready = true;
  }
} catch (e) { /* web-push not installed → push disabled */ }

const publicKey = () => process.env.WALLET_VAPID_PUBLIC || null;

async function subscribe(memberId, sub) {
  if (!memberId || !sub || !sub.endpoint || !sub.keys) return;
  await prisma.$executeRawUnsafe(
    `INSERT INTO mw_push_subs (member_id, endpoint, p256dh, auth) VALUES ($1::uuid,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET member_id=EXCLUDED.member_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`,
    memberId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

async function unsubscribe(endpoint) {
  if (endpoint) await prisma.$executeRawUnsafe(`DELETE FROM mw_push_subs WHERE endpoint=$1`, endpoint);
}

// Fire a push to all of a member's devices. payload: { title, body, url? }.
async function sendToMember(memberId, payload) {
  if (!ready || !memberId) return;
  let subs = [];
  try { subs = await prisma.$queryRawUnsafe(`SELECT endpoint, p256dh, auth FROM mw_push_subs WHERE member_id=$1::uuid`, memberId); }
  catch (e) { return; }
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await unsubscribe(s.endpoint).catch(() => {}); }
  }
}

module.exports = { publicKey, subscribe, unsubscribe, sendToMember, ready: () => ready };
