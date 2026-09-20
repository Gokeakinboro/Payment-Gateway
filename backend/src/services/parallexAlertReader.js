'use strict';
/**
 * parallexAlertReader.js — reads Parallex "Transaction Alert" debit emails
 * from the Zoho IMAP inbox, parses the transaction summary, stores each alert
 * in bank_debit_alerts, then auto-matches against rail_disbursements.
 *
 * Required env vars:
 *   IMAP_HOST  — imap.zoho.com
 *   IMAP_PORT  — 993
 *   IMAP_USER  — gokeakinboro@paylodeservices.com  (mailbox receiving the alerts)
 *   IMAP_PASS  — Zoho app password
 *   PARALLEX_ALERT_SENDER — defaults to alerts@parallexbank.com
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { prisma } = require('../utils/db');
const { logger } = require('../utils/logger');

const IMAP_HOST   = process.env.IMAP_HOST  || 'imap.zoho.com';
const IMAP_PORT   = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER   = process.env.IMAP_USER  || '';
const IMAP_PASS   = process.env.IMAP_PASS  || '';
const ALERT_FROM  = process.env.PARALLEX_ALERT_SENDER || 'alerts@parallexbank.com';

// ── Parse "11-Sep-2026 16:26:48" → Date ─────────────────────────────────────
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseAlertDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]));
}

// ── Parse "-15,600.00" → kobo BigInt ────────────────────────────────────────
function parseAmountKobo(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  if (!isFinite(n) || n === 0) return null;
  return BigInt(Math.round(Math.abs(n) * 100));
}

// ── Parse naira string "107,071,251.50" → number ────────────────────────────
function parseNaira(s) {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

// ── Extract beneficiary name from description "TPT: TRF TO NAME 123456..." ──
function extractBeneficiary(desc) {
  if (!desc) return null;
  // "TPT: TRF TO QUEEN FRIDAY 12026091..." — name is everything between "TRF TO " and the trailing digits
  const m = String(desc).match(/TRF\s+TO\s+([A-Z][A-Z\s]+?)\s+\d{10,}/i);
  if (m) return m[1].trim();
  // Fallback: take everything after "TRF TO " up to a long digit run or end
  const m2 = String(desc).match(/TRF\s+TO\s+(.+?)(?:\s+\d{8,}|$)/i);
  return m2 ? m2[1].trim() : null;
}

// ── Parse email plain text into a field map ──────────────────────────────────
// The Parallex alert email has a "Transaction Summary" HTML table.
// mailparser converts it to plain text as "Label   Value" pairs.
function parseAlertText(text) {
  if (!text) return null;
  const clean = text.replace(/\r\n/g, '\n');

  const field = (label) => {
    // match "Label  value" with 1+ whitespace separator, case-insensitive
    const re = new RegExp(label + '\\s{2,}([^\\n]+)', 'i');
    const m = clean.match(re);
    return m ? m[1].trim() : null;
  };

  const amount      = field('Amount');
  const txType      = field('Transaction\\s*Type');
  const description = field('Description');
  const dateTime    = field('Date\\s*and\\s*Time');
  const availBal    = field('Available\\s*Balance');
  const currBal     = field('Current\\s*Balance');
  const txRef       = field('Transaction\\s*Reference');

  // Only process Debit alerts
  if (txType && !/debit/i.test(txType)) return null;

  const amountKobo = parseAmountKobo(amount);
  if (!amountKobo) return null;

  return {
    amountKobo,
    description:       description || null,
    beneficiaryName:   extractBeneficiary(description),
    txReference:       txRef ? String(txRef).replace(/\s/g, '') : null,
    alertAt:           parseAlertDate(dateTime),
    availableBalance:  parseNaira(availBal),
    currentBalance:    parseNaira(currBal),
  };
}

// ── Auto-match one alert against rail_disbursements ──────────────────────────
// Match window: amount must be exact; time within ±20 minutes; rail must be Parallex.
async function autoMatch(alert) {
  const windowMin = new Date(alert.alert_at - 20 * 60_000);
  const windowMax = new Date(+alert.alert_at  + 20 * 60_000);

  // Look for a Parallex rail_disbursement with the same amount in the time window
  const rows = await prisma.$queryRawUnsafe(`
    SELECT rd.id, rd.rail_order_id, rd.status, rd.settled_at, rd.sent_at,
           pi.account_name, pr.name AS rail_name
    FROM rail_disbursements rd
    JOIN payment_rails pr ON pr.id = rd.rail_id
    LEFT JOIN payout_items pi ON pi.id = rd.payout_item_id
    WHERE rd.amount = $1
      AND pr.name ILIKE '%parallex%'
      AND rd.status IN ('success','sent','pending')
      AND COALESCE(rd.settled_at, rd.sent_at, rd.created_at) BETWEEN $2 AND $3
    ORDER BY COALESCE(rd.settled_at, rd.sent_at, rd.created_at) ASC
    LIMIT 5
  `, alert.amount_kobo, windowMin, windowMax);

  if (!rows.length) return { status: 'UNMATCHED', note: 'No rail_disbursement with matching amount in ±20min window', rdId: null };

  // Prefer a row whose account_name contains the beneficiary name
  const bn = (alert.beneficiary_name || '').toUpperCase();
  const best = rows.find(r => bn && r.account_name && r.account_name.toUpperCase().includes(bn.split(' ')[0]))
            || rows[0];

  return {
    status: 'MATCHED',
    note:   `Matched rail_disbursements/${best.id} (${best.rail_name}, status=${best.status})`,
    rdId:   best.id,
  };
}

// ── Main: fetch + process new Parallex alert emails ─────────────────────────
async function syncParallexAlerts({ maxMessages = 50 } = {}) {
  if (!IMAP_USER || !IMAP_PASS) {
    logger.warn('parallexAlertReader: IMAP_USER/IMAP_PASS not set — skipping');
    return { fetched: 0, stored: 0, matched: 0 };
  }

  const client = new ImapFlow({
    host:   IMAP_HOST,
    port:   IMAP_PORT,
    secure: true,
    auth:   { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,  // suppress imapflow's own verbose logging
  });

  await client.connect();
  let fetched = 0, stored = 0, matched = 0;

  try {
    await client.mailboxOpen('INBOX');

    // Search for unseen emails from the alert sender
    const uids = await client.search({ from: ALERT_FROM, subject: 'Transaction Alert', seen: false });

    if (!uids.length) {
      logger.info('parallexAlertReader: no new alert emails');
      return { fetched: 0, stored: 0, matched: 0 };
    }

    const toFetch = uids.slice(-maxMessages);  // newest N

    for await (const msg of client.fetch(toFetch, { envelope: true, source: true }, { uid: true })) {
      fetched++;
      const uid = String(msg.uid);

      // Skip if already stored
      const existing = await prisma.$queryRawUnsafe(
        `SELECT id FROM bank_debit_alerts WHERE imap_message_id = $1 LIMIT 1`, uid
      );
      if (existing.length) continue;

      // Parse the raw email source
      const parsed = await simpleParser(msg.source);
      const rawText = parsed.text || '';

      const fields = parseAlertText(rawText);
      if (!fields) {
        // Not a debit, or unrecognised format — mark seen and skip
        await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
        continue;
      }

      // Store the alert
      await prisma.$executeRawUnsafe(`
        INSERT INTO bank_debit_alerts
          (imap_message_id, source, amount_kobo, description, beneficiary_name,
           tx_reference, alert_at, available_balance_naira, current_balance_naira, raw_text)
        VALUES ($1,'parallex',$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (imap_message_id) DO NOTHING
      `, uid, fields.amountKobo, fields.description, fields.beneficiaryName,
         fields.txReference, fields.alertAt, fields.availableBalance,
         fields.currentBalance, rawText.slice(0, 4000));
      stored++;

      // Attempt auto-match
      if (fields.alertAt) {
        const alertRow = await prisma.$queryRawUnsafe(
          `SELECT id, amount_kobo, alert_at, beneficiary_name FROM bank_debit_alerts WHERE imap_message_id = $1`, uid
        );
        if (alertRow.length) {
          const m = await autoMatch(alertRow[0]);
          await prisma.$executeRawUnsafe(`
            UPDATE bank_debit_alerts
            SET match_status = $1, match_note = $2, matched_rd_id = $3
            WHERE id = $4
          `, m.status, m.note, m.rdId || null, alertRow[0].id);
          if (m.status === 'MATCHED') matched++;
        }
      }

      // Mark as seen so we don't re-process it next run
      await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
    }
  } finally {
    await client.logout();
  }

  logger.info({ fetched, stored, matched }, 'parallexAlertReader: sync complete');
  return { fetched, stored, matched };
}

module.exports = { syncParallexAlerts };
