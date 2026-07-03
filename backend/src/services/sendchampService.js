'use strict';
/**
 * SendChamp WhatsApp sender — best-effort, config-gated.
 *
 * WhatsApp business-initiated messages must use a Meta-approved TEMPLATE, so we
 * only ever send template messages. If the key, the sender, or the relevant
 * template_code is not configured, sends are SKIPPED (logged) — invoice/receipt
 * email flows are never blocked by WhatsApp.
 *
 * Env (set in the server .env, not in git):
 *   SENDCHAMP_PUBLIC_KEY            live/sandbox public access key
 *   SENDCHAMP_BASE_URL             default https://api.sendchamp.com/api/v1
 *   SENDCHAMP_WA_SENDER            approved WhatsApp sender number (e.g. 2349073128016)
 *   SENDCHAMP_WA_TEMPLATE_INVOICE  template_code for invoice notifications
 *   SENDCHAMP_WA_TEMPLATE_RECEIPT  template_code for payment receipts
 *
 * NOTE: custom_data.body keys ("1","2",…) map POSITIONALLY to the template's
 * variables. Adjust the maps in notifyInvoice/notifyReceipt to match the exact
 * variable order of the approved templates once they exist.
 */
const https = require('https');
const { logger } = require('../utils/logger');

const KEY       = process.env.SENDCHAMP_PUBLIC_KEY || '';
const BASE      = (process.env.SENDCHAMP_BASE_URL || 'https://api.sendchamp.com/api/v1').replace(/\/$/, '');
const SENDER    = process.env.SENDCHAMP_WA_SENDER || '';
const T_INVOICE = process.env.SENDCHAMP_WA_TEMPLATE_INVOICE || '';
const T_RECEIPT = process.env.SENDCHAMP_WA_TEMPLATE_RECEIPT || '';

const isConfigured = () => !!(KEY && SENDER);

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
    const u = new URL(BASE + path);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json',
        'Accept': 'application/json', 'Content-Length': Buffer.byteLength(payload),
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

// Low-level: send one approved WhatsApp template. bodyVars = { "1": v, "2": v, … }.
async function sendTemplate(recipient, templateCode, bodyVars = {}) {
  if (!isConfigured() || !templateCode) {
    logger.debug({ templateCode, configured: isConfigured() }, 'SendChamp WhatsApp skipped (not configured)');
    return { skipped: true, reason: 'not_configured' };
  }
  const to = normalizePhone(recipient);
  if (!to) { logger.debug({ recipient }, 'SendChamp WhatsApp skipped (no valid phone)'); return { skipped: true, reason: 'no_phone' }; }
  try {
    const r = await postJson('/whatsapp/message/send', {
      recipient: to, sender: SENDER, template_code: templateCode, type: 'template',
      custom_data: { body: bodyVars },
    });
    const ok = r.status >= 200 && r.status < 300 && r.body && r.body.status !== 'failed';
    (ok ? logger.info : logger.warn)({ to, templateCode, status: r.status, resp: r.body },
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

// Invoice notification — variable order must match SENDCHAMP_WA_TEMPLATE_INVOICE.
function notifyInvoice({ phone, recipientName, businessName, invoiceNumber, amount, currency, payUrl }) {
  return sendTemplate(phone, T_INVOICE, {
    '1': recipientName || 'there',
    '2': businessName || 'Paylode',
    '3': invoiceNumber || '',
    '4': formatMoney(amount, currency),
    '5': payUrl || '',
  });
}

// Payment receipt — variable order must match SENDCHAMP_WA_TEMPLATE_RECEIPT.
function notifyReceipt({ phone, recipientName, businessName, invoiceNumber, amount, currency }) {
  return sendTemplate(phone, T_RECEIPT, {
    '1': recipientName || 'there',
    '2': businessName || 'Paylode',
    '3': invoiceNumber || '',
    '4': formatMoney(amount, currency),
  });
}

module.exports = { sendTemplate, notifyInvoice, notifyReceipt, normalizePhone, isConfigured };
