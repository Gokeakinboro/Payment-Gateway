'use strict';
/**
 * WhatsApp sender — Meta WhatsApp Cloud API (direct, no BSP).
 *
 * Best-effort + config-gated: if the access token, phone-number id, or the
 * relevant template name is missing, sends are SKIPPED (logged) so invoice/
 * receipt email flows are never blocked. WhatsApp business-initiated messages
 * must use a Meta-APPROVED template, so we only ever send template messages.
 *
 * Env (set in the server .env, not in git):
 *   WHATSAPP_ACCESS_TOKEN          Meta system-user / permanent token
 *   WHATSAPP_PHONE_NUMBER_ID       the sender's phone-number id (from Meta)
 *   WHATSAPP_API_VERSION           Graph API version, default v21.0
 *   WHATSAPP_GRAPH_BASE            default https://graph.facebook.com
 *   WHATSAPP_TEMPLATE_INVOICE       approved template name for invoice notices
 *   WHATSAPP_TEMPLATE_INVOICE_LANG  language code, default en
 *   WHATSAPP_TEMPLATE_PAYMENT_LINK  approved template name for payment-link shares
 *   WHATSAPP_TEMPLATE_PAYMENT_LINK_LANG language code, default en
 *   WHATSAPP_TEMPLATE_QR            approved template name for QR-code shares
 *   WHATSAPP_TEMPLATE_QR_LANG       language code, default en
 *
 * Billing (merchant_id + event_type in opts):
 *   Each successful send is logged in whatsapp_message_log. The merchant is
 *   charged their configured price per message; messages within the daily free
 *   tier are borne by Paylode (meta_cost_kobo recorded, merchant_charge = 0).
 */
const https = require('https');
const { logger } = require('../utils/logger');
const { prisma } = require('../utils/db');

const TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN || '';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const VERSION  = process.env.WHATSAPP_API_VERSION || 'v21.0';
const GRAPH    = (process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, '');
const T_INVOICE      = process.env.WHATSAPP_TEMPLATE_INVOICE || '';
const T_INVOICE_LANG = process.env.WHATSAPP_TEMPLATE_INVOICE_LANG || 'en';
const T_PAYLINK      = process.env.WHATSAPP_TEMPLATE_PAYMENT_LINK || '';
const T_PAYLINK_LANG = process.env.WHATSAPP_TEMPLATE_PAYMENT_LINK_LANG || 'en';
const T_QR           = process.env.WHATSAPP_TEMPLATE_QR || '';
const T_QR_LANG      = process.env.WHATSAPP_TEMPLATE_QR_LANG || 'en';
const T_RECEIPT          = process.env.WHATSAPP_TEMPLATE_RECEIPT || '';
const T_RECEIPT_LANG     = process.env.WHATSAPP_TEMPLATE_RECEIPT_LANG || 'en';
const T_CHECKOUT_RECEIPT = process.env.WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT || '';
const T_CHECKOUT_LANG    = process.env.WHATSAPP_TEMPLATE_CHECKOUT_RECEIPT_LANG || 'en';
const T_PAYOUT_SUMMARY   = process.env.WHATSAPP_TEMPLATE_PAYOUT_SUMMARY || '';
const T_PAYOUT_SUM_LANG  = process.env.WHATSAPP_TEMPLATE_PAYOUT_SUMMARY_LANG || 'en';

const isConfigured = () => !!(TOKEN && PHONE_ID);

// Normalise to bare international digits (no '+'). Assumes Nigeria for local forms.
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '234' + p.slice(1);          // 080… → 23480…
  else if (/^[789]\d{9}$/.test(p)) p = '234' + p;          // 80……… → 23480………
  return /^\d{10,15}$/.test(p) ? p : null;
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(GRAPH + path);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
        catch { resolve({ status: res.statusCode, body: { raw: d } }); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ── Billing helpers ───────────────────────────────────────────────────────────

async function _getWhatsappPlatformCost() {
  try {
    const row = await prisma.platformSettings.findUnique({ where: { key: 'whatsapp' } });
    return Number((row?.value || {}).meta_cost_per_message_kobo || 0);
  } catch { return 0; }
}

async function _countTodayMessages(merchantId) {
  try {
    const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0);
    const result = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS cnt FROM whatsapp_message_log
        WHERE merchant_id = $1::uuid AND sent_at >= $2 AND succeeded = TRUE`,
      merchantId, todayUtc);
    return Number(result[0]?.cnt || 0);
  } catch { return 0; }
}

async function _billMessage(merchantId, eventType, metaMessageId, succeeded) {
  try {
    const [metaCostKobo, merchant] = await Promise.all([
      _getWhatsappPlatformCost(),
      prisma.merchant.findUnique({ where: { id: merchantId }, select: { notificationSettings: true } }),
    ]);
    const ns = merchant?.notificationSettings || {};
    const pricePerMsg = Number(ns.whatsapp_price_per_message_kobo || 0);
    const freeTier    = Number(ns.whatsapp_free_tier_per_day || 0);
    const todayCount  = freeTier > 0 ? await _countTodayMessages(merchantId) : 0;
    const isFreeTier  = freeTier > 0 && todayCount < freeTier;
    await prisma.whatsappMessageLog.create({
      data: {
        merchantId, eventType,
        isFreeTier,
        merchantChargeKobo: BigInt(isFreeTier ? 0 : pricePerMsg),
        metaCostKobo: BigInt(metaCostKobo),
        metaMessageId: metaMessageId || null,
        succeeded,
      },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'WhatsApp billing log failed');
  }
}

// ── Core send ─────────────────────────────────────────────────────────────────

// opts = { merchantId?, eventType? } — when provided, logs billing entry after send.
async function sendTemplate(recipient, templateName, languageCode, params = [], opts = {}) {
  if (!isConfigured() || !templateName) {
    logger.debug({ templateName, configured: isConfigured() }, 'WhatsApp skipped (not configured)');
    return { skipped: true, reason: 'not_configured' };
  }
  const to = normalizePhone(recipient);
  if (!to) { logger.debug({ recipient }, 'WhatsApp skipped (no valid phone)'); return { skipped: true, reason: 'no_phone' }; }

  const template = { name: templateName, language: { code: languageCode || 'en' } };
  if (params.length) {
    template.components = [{ type: 'body', parameters: params.map((v) => {
      if (v !== null && typeof v === 'object' && 'name' in v) {
        return { type: 'text', parameter_name: v.name, text: String(v.value == null ? '' : v.value) };
      }
      return { type: 'text', text: String(v == null ? '' : v) };
    }) }];
  }
  let sendOk = false, msgId = null;
  try {
    const r = await postJson(`/${VERSION}/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template,
    });
    sendOk = r.status >= 200 && r.status < 300 && r.body && !r.body.error;
    msgId  = r.body?.messages?.[0]?.id;
    if (sendOk) {
      logger.info({ to, templateName, status: r.status, id: msgId }, 'WhatsApp sent');
    } else {
      logger.warn({ to, templateName, status: r.status, err: r.body?.error, body: r.body }, 'WhatsApp send failed');
    }
    if (opts.merchantId) _billMessage(opts.merchantId, opts.eventType || 'unknown', msgId, sendOk).catch(() => {});
    return { ok: sendOk, response: r.body };
  } catch (e) {
    logger.warn({ to, err: e.message }, 'WhatsApp send error');
    if (opts.merchantId) _billMessage(opts.merchantId, opts.eventType || 'unknown', null, false).catch(() => {});
    return { ok: false, error: e.message };
  }
}

function formatMoney(kobo, currency) {
  const sym = currency === 'USD' ? '$' : '₦';
  return sym + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Invoice notification — params ORDER must match WHATSAPP_TEMPLATE_INVOICE.
function notifyInvoice({ phone, recipientName, businessName, invoiceNumber, amount, currency, payUrl, merchantId }) {
  return sendTemplate(phone, T_INVOICE, T_INVOICE_LANG, [
    { name: 'customer_name',   value: recipientName || 'there' },
    { name: 'business_name',   value: businessName || 'Paylode' },
    { name: 'invoice_number',  value: invoiceNumber || '' },
    { name: 'amount_due',      value: formatMoney(amount, currency) },
    { name: 'pay_url',         value: payUrl || '' },
  ], { merchantId, eventType: 'invoice' });
}

// Payment-link share — params ORDER must match WHATSAPP_TEMPLATE_PAYMENT_LINK.
function notifyPaymentLink({ phone, businessName, title, amount, currency, payUrl, merchantId }) {
  return sendTemplate(phone, T_PAYLINK, T_PAYLINK_LANG, [
    businessName || 'Paylode',
    title || 'Payment request',
    amount == null ? 'any amount' : formatMoney(amount, currency),
    payUrl || '',
  ], { merchantId, eventType: 'payment_link' });
}

// QR-code share — params ORDER must match WHATSAPP_TEMPLATE_QR.
function notifyQr({ phone, businessName, label, payUrl, merchantId }) {
  return sendTemplate(phone, T_QR, T_QR_LANG, [
    businessName || 'Paylode',
    label || 'Scan to pay',
    payUrl || '',
  ], { merchantId, eventType: 'qr' });
}

// Payment receipt — params ORDER must match WHATSAPP_TEMPLATE_RECEIPT.
function notifyReceipt({ phone, recipientName, businessName, invoiceNumber, amount, currency, merchantId }) {
  return sendTemplate(phone, T_RECEIPT, T_RECEIPT_LANG, [
    recipientName || 'there',
    businessName || 'Paylode',
    invoiceNumber || '',
    formatMoney(amount, currency),
  ], { merchantId, eventType: 'payment_received' });
}

// Checkout payment receipt — fired when a customer's pay-in is confirmed.
// Phone must come from transaction metadata (customer_phone / customerPhone).
// Self-loads the transaction + merchant notification settings by reference.
async function notifyCheckoutReceipt(reference) {
  if (!T_CHECKOUT_RECEIPT) return;
  try {
    const txn = await prisma.transaction.findUnique({
      where: { reference },
      include: { merchant: { select: { businessName: true, notificationSettings: true, id: true } } },
    });
    if (!txn || txn.status !== 'SUCCESS') return;
    const ns = txn.merchant?.notificationSettings || {};
    // Honour per-merchant opt-in. Also accept the legacy whatsapp_payment_received key.
    if (!ns.whatsapp_checkout_receipt && !ns.whatsapp_payment_received) return;
    const phone = (txn.metadata && (txn.metadata.customer_phone || txn.metadata.customerPhone)) || null;
    if (!phone) return;
    const ccy   = txn.currency || 'NGN';
    const paidKobo = (txn.metadata?.payin?.charge != null) ? txn.metadata.payin.charge : txn.amount;
    const dateStr  = new Date(txn.paidAt || Date.now()).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
    return sendTemplate(phone, T_CHECKOUT_RECEIPT, T_CHECKOUT_LANG, [
      { name: 'customer_name',  value: txn.customerEmail ? txn.customerEmail.split('@')[0] : 'there' },
      { name: 'amount_paid',    value: formatMoney(paidKobo, ccy) },
      { name: 'business_name',  value: txn.merchant?.businessName || 'Paylode' },
      { name: 'reference',      value: txn.reference },
      { name: 'date_time',      value: dateStr },
    ], { merchantId: txn.merchant?.id, eventType: 'checkout_receipt' });
  } catch (e) {
    logger.warn({ err: e.message, reference }, 'WhatsApp checkout receipt failed');
  }
}

// Merchant payout batch summary — fired when a batch reaches terminal status.
// Self-loads the batch + merchant from batchId.
async function notifyMerchantPayoutSummary(batchId) {
  if (!T_PAYOUT_SUMMARY) return;
  try {
    const batch = await prisma.payoutBatch.findUnique({
      where: { id: batchId },
      include: { merchant: { select: { businessName: true, businessPhone: true, notificationSettings: true, id: true } } },
    });
    if (!batch || !['completed', 'partially_failed', 'failed'].includes(batch.status)) return;
    const ns = batch.merchant?.notificationSettings || {};
    if (!ns.whatsapp_payout_summary) return;
    const phone = batch.merchant?.businessPhone;
    if (!phone) return;
    const total    = formatMoney(batch.totalAmount, 'NGN');
    const count    = String(batch.totalItems || 0);
    const sentAt   = new Date().toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
    return sendTemplate(phone, T_PAYOUT_SUMMARY, T_PAYOUT_SUM_LANG, [
      { name: 'merchant_name',  value: batch.merchant?.businessName || 'Merchant' },
      { name: 'total_amount',   value: total },
      { name: 'txn_count',      value: count },
      { name: 'dispatch_time',  value: sentAt },
    ], { merchantId: batch.merchant?.id, eventType: 'payout_summary' });
  } catch (e) {
    logger.warn({ err: e.message, batchId }, 'WhatsApp payout summary failed');
  }
}

module.exports = { sendTemplate, notifyInvoice, notifyReceipt, notifyPaymentLink, notifyQr,
  notifyCheckoutReceipt, notifyMerchantPayoutSummary, normalizePhone, isConfigured };
