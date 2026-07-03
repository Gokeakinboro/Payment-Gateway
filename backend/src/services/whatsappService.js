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
 * Template body variables ({{1}},{{2}},…) are positional — the params arrays in
 * notifyInvoice/notifyReceipt must match each approved template's variable order.
 */
const https = require('https');
const { logger } = require('../utils/logger');

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
const T_RECEIPT      = process.env.WHATSAPP_TEMPLATE_RECEIPT || '';
const T_RECEIPT_LANG = process.env.WHATSAPP_TEMPLATE_RECEIPT_LANG || 'en';

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

// Low-level: send one approved template. params = ordered body variable values.
async function sendTemplate(recipient, templateName, languageCode, params = []) {
  if (!isConfigured() || !templateName) {
    logger.debug({ templateName, configured: isConfigured() }, 'WhatsApp skipped (not configured)');
    return { skipped: true, reason: 'not_configured' };
  }
  const to = normalizePhone(recipient);
  if (!to) { logger.debug({ recipient }, 'WhatsApp skipped (no valid phone)'); return { skipped: true, reason: 'no_phone' }; }

  const template = { name: templateName, language: { code: languageCode || 'en' } };
  if (params.length) {
    template.components = [{ type: 'body', parameters: params.map((v) => ({ type: 'text', text: String(v == null ? '' : v) })) }];
  }
  try {
    const r = await postJson(`/${VERSION}/${PHONE_ID}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template,
    });
    const ok = r.status >= 200 && r.status < 300 && r.body && !r.body.error;
    (ok ? logger.info : logger.warn)(
      { to, templateName, status: r.status, id: r.body?.messages?.[0]?.id, err: r.body?.error },
      ok ? 'WhatsApp sent' : 'WhatsApp send failed');
    return { ok, response: r.body };
  } catch (e) {
    logger.warn({ to, err: e.message }, 'WhatsApp send error');
    return { ok: false, error: e.message };
  }
}

function formatMoney(kobo, currency) {
  const sym = currency === 'USD' ? '$' : '₦';
  return sym + (Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });
}

// Invoice notification — params ORDER must match WHATSAPP_TEMPLATE_INVOICE.
function notifyInvoice({ phone, recipientName, businessName, invoiceNumber, amount, currency, payUrl }) {
  return sendTemplate(phone, T_INVOICE, T_INVOICE_LANG, [
    recipientName || 'there',
    businessName || 'Paylode',
    invoiceNumber || '',
    formatMoney(amount, currency),
    payUrl || '',
  ]);
}

// Payment-link share — params ORDER must match WHATSAPP_TEMPLATE_PAYMENT_LINK.
function notifyPaymentLink({ phone, businessName, title, amount, currency, payUrl }) {
  return sendTemplate(phone, T_PAYLINK, T_PAYLINK_LANG, [
    businessName || 'Paylode',
    title || 'Payment request',
    amount == null ? 'any amount' : formatMoney(amount, currency),
    payUrl || '',
  ]);
}

// QR-code share — params ORDER must match WHATSAPP_TEMPLATE_QR.
function notifyQr({ phone, businessName, label, payUrl }) {
  return sendTemplate(phone, T_QR, T_QR_LANG, [
    businessName || 'Paylode',
    label || 'Scan to pay',
    payUrl || '',
  ]);
}

// Payment receipt — params ORDER must match WHATSAPP_TEMPLATE_RECEIPT.
function notifyReceipt({ phone, recipientName, businessName, invoiceNumber, amount, currency }) {
  return sendTemplate(phone, T_RECEIPT, T_RECEIPT_LANG, [
    recipientName || 'there',
    businessName || 'Paylode',
    invoiceNumber || '',
    formatMoney(amount, currency),
  ]);
}

module.exports = { sendTemplate, notifyInvoice, notifyReceipt, notifyPaymentLink, notifyQr, normalizePhone, isConfigured };
