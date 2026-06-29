'use strict';

/**
 * Paylode Node.js SDK
 * Official server-side SDK for Paylode Services Limited
 * CBN Licensed PSSP — paylodeservices.com
 * Version: 1.0.0
 */

const https = require('https');
const crypto = require('crypto');

const BASE_URL = 'api.paylodeservices.com';
const API_VERSION = 'v1';
const SDK_VERSION = '1.0.0';

// ─── KYC Tier Limits (enforced server-side too) ───────────────────────────
const KYC_LIMITS = {
  tier_1: {
    single_txn:  5000000,      // ₦50,000 in kobo
    daily:       30000000,     // ₦300,000
    monthly:     100000000,    // ₦1,000,000
    channels:    ['card', 'ussd'],
  },
  tier_2: {
    single_txn:  100000000,    // ₦1,000,000
    daily:       1000000000,   // ₦10,000,000
    monthly:     5000000000,   // ₦50,000,000
    channels:    ['card', 'bank_transfer', 'ussd'],
  },
  tier_3: {
    single_txn:  500000000,    // ₦5,000,000
    daily:       10000000000,  // ₦100,000,000
    monthly:     null,         // custom — set by Paylode ops
    channels:    ['card', 'bank_transfer', 'ussd', 'direct_debit'],
  },
};

// ─── HTTP Client ─────────────────────────────────────────────────────────
function request(secretKey, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: BASE_URL,
      port: 443,
      path: `/${API_VERSION}/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Paylode-SDK': `node/${SDK_VERSION}`,
        'X-Paylode-Node': process.version,
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new PaylodeError(
              parsed.message || 'API error',
              parsed.error_code || 'API_ERROR',
              res.statusCode,
              parsed
            );
            reject(err);
          }
        } catch (e) {
          reject(new PaylodeError('Failed to parse API response', 'PARSE_ERROR', res.statusCode));
        }
      });
    });

    req.on('error', (e) => reject(new PaylodeError(e.message, 'NETWORK_ERROR', 0)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Custom Error Class ───────────────────────────────────────────────────
class PaylodeError extends Error {
  constructor(message, code, statusCode, raw = null) {
    super(message);
    this.name = 'PaylodeError';
    this.code = code;
    this.statusCode = statusCode;
    this.raw = raw;
  }
}

// ─── Transactions Resource ────────────────────────────────────────────────
class Transactions {
  constructor(secretKey) { this._key = secretKey; }

  /**
   * Initialize a transaction
   * @param {object} params
   * @param {string} params.email         - Customer email (required)
   * @param {number} params.amount        - Amount in kobo (required)
   * @param {string} [params.reference]   - Unique ref (auto-generated if omitted)
   * @param {string} [params.currency]    - NGN (default)
   * @param {string} [params.callback_url]
   * @param {string[]} [params.channels]  - ['card','bank_transfer','ussd']
   * @param {object} [params.metadata]    - Arbitrary passthrough object
   */
  async initialize(params) {
    if (!params.email) throw new PaylodeError('email is required', 'MISSING_FIELD', 400);
    if (!params.amount) throw new PaylodeError('amount is required', 'MISSING_FIELD', 400);
    if (typeof params.amount !== 'number' || params.amount < 10000) {
      throw new PaylodeError('amount must be a number in kobo, minimum ₦100 (10000 kobo)', 'INVALID_AMOUNT', 400);
    }
    const body = {
      email: params.email,
      amount: params.amount,
      currency: params.currency || 'NGN',
      reference: params.reference || generateRef(),
      callback_url: params.callback_url,
      channels: params.channels,
      metadata: params.metadata || {},
    };
    return request(this._key, 'POST', 'transaction/initialize', body);
  }

  /**
   * Verify a transaction by reference
   * ALWAYS call this server-side before fulfilling any order
   * @param {string} reference
   */
  async verify(reference) {
    if (!reference) throw new PaylodeError('reference is required', 'MISSING_FIELD', 400);
    return request(this._key, 'GET', `transaction/verify/${reference}`);
  }

  /**
   * List transactions
   * @param {object} [params]
   * @param {number} [params.page]
   * @param {number} [params.perPage]
   * @param {string} [params.status]      - success | failed | pending
   * @param {string} [params.from]        - ISO date string
   * @param {string} [params.to]          - ISO date string
   */
  async list(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(this._key, 'GET', `transaction?${qs}`);
  }

  /**
   * Fetch a single transaction by ID
   * @param {string} id
   */
  async fetch(id) {
    if (!id) throw new PaylodeError('transaction id is required', 'MISSING_FIELD', 400);
    return request(this._key, 'GET', `transaction/${id}`);
  }

  /**
   * Initiate a refund
   * @param {string} reference  - Original transaction reference
   * @param {number} [amount]   - Partial refund amount in kobo (omit for full refund)
   * @param {string} [reason]
   */
  async refund(reference, amount = null, reason = '') {
    if (!reference) throw new PaylodeError('reference is required', 'MISSING_FIELD', 400);
    const body = { reference, reason };
    if (amount) body.amount = amount;
    return request(this._key, 'POST', 'refund', body);
  }
}

// ─── Customers Resource ───────────────────────────────────────────────────
class Customers {
  constructor(secretKey) { this._key = secretKey; }

  async create(params) {
    const required = ['email', 'first_name', 'last_name'];
    for (const f of required) {
      if (!params[f]) throw new PaylodeError(`${f} is required`, 'MISSING_FIELD', 400);
    }
    return request(this._key, 'POST', 'customer', params);
  }

  async fetch(emailOrCode) {
    return request(this._key, 'GET', `customer/${emailOrCode}`);
  }

  async list(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(this._key, 'GET', `customer?${qs}`);
  }

  async update(code, params) {
    return request(this._key, 'PUT', `customer/${code}`, params);
  }
}

// ─── Subaccounts (for aggregator split payments) ──────────────────────────
class Subaccounts {
  constructor(secretKey) { this._key = secretKey; }

  /**
   * Create a subaccount for a merchant under an aggregator
   * @param {object} params
   * @param {string} params.business_name
   * @param {string} params.settlement_bank   - Bank code
   * @param {string} params.account_number
   * @param {number} params.percentage_charge - Aggregator's share (0-100)
   * @param {string} [params.description]
   */
  async create(params) {
    const required = ['business_name', 'settlement_bank', 'account_number', 'percentage_charge'];
    for (const f of required) {
      if (params[f] === undefined) throw new PaylodeError(`${f} is required`, 'MISSING_FIELD', 400);
    }
    return request(this._key, 'POST', 'subaccount', params);
  }

  async fetch(code) {
    return request(this._key, 'GET', `subaccount/${code}`);
  }

  async list(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(this._key, 'GET', `subaccount?${qs}`);
  }

  async update(code, params) {
    return request(this._key, 'PUT', `subaccount/${code}`, params);
  }
}

// ─── Settlements Resource ─────────────────────────────────────────────────
class Settlements {
  constructor(secretKey) { this._key = secretKey; }

  async list(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(this._key, 'GET', `settlement?${qs}`);
  }

  async fetch(id) {
    return request(this._key, 'GET', `settlement/${id}`);
  }
}

// ─── Invoice & Collect Resource ───────────────────────────────────────────
// Modular billing: invoices, scan-to-pay QR codes, contacts/lists, products,
// branding format and collection reports. Mirrors /api/v1/invoicing/*.
// All amounts are in kobo (integer). Reusable by any platform (e.g. golf clubs)
// that holds a Paylode sk_live_/sk_test_ key — each key resolves to a merchant.
function qsOf(params) {
  const clean = {};
  Object.keys(params || {}).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') clean[k] = params[k];
  });
  return new URLSearchParams(clean).toString();
}

class Invoicing {
  constructor(secretKey) {
    const key = secretKey;
    const req = (m, p, b) => request(key, m, p, b);

    // ── Invoices ──────────────────────────────────────────────────────────
    // create({ amount(kobo, req), description?, currency?, charge_vat?,
    //   allow_part_payment?, scheduled_at?, due_at?, reminder_interval_days?,
    //   reminder_count?, department_id?,
    //   recipients: { email?,name?,phone?, contact_id?, contact_ids?:[],
    //                 list_ids?:[], all_contacts?:bool } })
    this.invoices = {
      create: (params = {}) => {
        if (params.amount === undefined || params.amount === null) {
          throw new PaylodeError('amount is required', 'MISSING_FIELD', 400);
        }
        if (typeof params.amount !== 'number' || !Number.isInteger(params.amount) || params.amount < 100) {
          throw new PaylodeError('amount must be a whole number in kobo (≥ 100)', 'INVALID_AMOUNT', 400);
        }
        if (!params.recipients || typeof params.recipients !== 'object') {
          throw new PaylodeError('recipients targeting object is required', 'MISSING_FIELD', 400);
        }
        return req('POST', 'invoicing/invoices', params);
      },
      list: (params = {}) => req('GET', `invoicing/invoices?${qsOf(params)}`),
      fetch: (id) => {
        if (!id) throw new PaylodeError('invoice id is required', 'MISSING_FIELD', 400);
        return req('GET', `invoicing/invoices/${id}`);
      },
      send: (id) => {
        if (!id) throw new PaylodeError('invoice id is required', 'MISSING_FIELD', 400);
        return req('POST', `invoicing/invoices/${id}/send`);
      },
      cancel: (id) => {
        if (!id) throw new PaylodeError('invoice id is required', 'MISSING_FIELD', 400);
        return req('POST', `invoicing/invoices/${id}/cancel`);
      },
    };

    // ── QR (scan-to-pay) ──────────────────────────────────────────────────
    // create({ type:'fixed'|'open', amount?(kobo, required when fixed),
    //          label?, charge_vat?, department_id? })
    this.qr = {
      create: (params = {}) => {
        if (params.type === 'fixed' && (typeof params.amount !== 'number' || params.amount < 100)) {
          throw new PaylodeError('a fixed-amount QR needs amount in kobo (≥ 100)', 'INVALID_AMOUNT', 400);
        }
        return req('POST', 'invoicing/qr', params);
      },
      list: () => req('GET', 'invoicing/qr'),
      setActive: (id, isActive) => {
        if (!id) throw new PaylodeError('qr id is required', 'MISSING_FIELD', 400);
        return req('PATCH', `invoicing/qr/${id}`, { is_active: !!isActive });
      },
      remove: (id) => {
        if (!id) throw new PaylodeError('qr id is required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/qr/${id}`);
      },
    };

    // ── Contacts ──────────────────────────────────────────────────────────
    this.contacts = {
      create: (params = {}) => {
        if (!params.name) throw new PaylodeError('name is required', 'MISSING_FIELD', 400);
        if (!params.email && !params.phone) throw new PaylodeError('an email or phone is required', 'MISSING_FIELD', 400);
        return req('POST', 'invoicing/contacts', params);
      },
      list: (params = {}) => req('GET', `invoicing/contacts?${qsOf(params)}`),
      // import(rows[], 'skip'|'overwrite') — rows: [{name,email?,phone?,tags?,custom_fields?}]
      import: (rows, onDuplicate = 'skip') => {
        if (!Array.isArray(rows) || !rows.length) throw new PaylodeError('rows array is required', 'MISSING_FIELD', 400);
        return req('POST', 'invoicing/contacts/import', { rows, on_duplicate: onDuplicate });
      },
      update: (id, params = {}) => {
        if (!id) throw new PaylodeError('contact id is required', 'MISSING_FIELD', 400);
        return req('PATCH', `invoicing/contacts/${id}`, params);
      },
      remove: (id) => {
        if (!id) throw new PaylodeError('contact id is required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/contacts/${id}`);
      },
    };

    // ── Lists ─────────────────────────────────────────────────────────────
    this.lists = {
      create: (params = {}) => {
        if (!params.name) throw new PaylodeError('name is required', 'MISSING_FIELD', 400);
        return req('POST', 'invoicing/lists', params);
      },
      list: () => req('GET', 'invoicing/lists'),
      members: (id) => {
        if (!id) throw new PaylodeError('list id is required', 'MISSING_FIELD', 400);
        return req('GET', `invoicing/lists/${id}/members`);
      },
      // update(id, { add:[contactIds], remove:[contactIds] })
      update: (id, params = {}) => {
        if (!id) throw new PaylodeError('list id is required', 'MISSING_FIELD', 400);
        return req('PATCH', `invoicing/lists/${id}`, params);
      },
      remove: (id) => {
        if (!id) throw new PaylodeError('list id is required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/lists/${id}`);
      },
    };

    // ── Products / Services ───────────────────────────────────────────────
    this.products = {
      create: (params = {}) => {
        if (!params.name) throw new PaylodeError('name is required', 'MISSING_FIELD', 400);
        return req('POST', 'invoicing/products', params);
      },
      list: () => req('GET', 'invoicing/products'),
      remove: (id) => {
        if (!id) throw new PaylodeError('product id is required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/products/${id}`);
      },
    };

    // ── Format / branding (singleton per merchant) ────────────────────────
    this.format = {
      get: () => req('GET', 'invoicing/formats'),
      // update({ logo_url?, address?, business_email?, business_phone?,
      //   layout?:'classic'|'modern'|'minimal'|'receipt',
      //   allow_part_payment_default?, charge_vat_default? })
      update: (params = {}) => req('PUT', 'invoicing/formats', params),
    };

    // ── Departments & departmental users ──────────────────────────────────
    this.departments = {
      create: (params = {}) => {
        if (!params.name) throw new PaylodeError('name is required', 'MISSING_FIELD', 400);
        return req('POST', 'invoicing/departments', params);
      },
      list: () => req('GET', 'invoicing/departments'),
      remove: (id) => {
        if (!id) throw new PaylodeError('department id is required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/departments/${id}`);
      },
      users: (id) => {
        if (!id) throw new PaylodeError('department id is required', 'MISSING_FIELD', 400);
        return req('GET', `invoicing/departments/${id}/users`);
      },
      // addUser(deptId, { name, email, phone? }) — onboards with a temp password
      addUser: (id, params = {}) => {
        if (!id) throw new PaylodeError('department id is required', 'MISSING_FIELD', 400);
        if (!params.name || !params.email) throw new PaylodeError('name and email are required', 'MISSING_FIELD', 400);
        return req('POST', `invoicing/departments/${id}/users`, params);
      },
      removeUser: (id, userMapId) => {
        if (!id || !userMapId) throw new PaylodeError('department id and user map id are required', 'MISSING_FIELD', 400);
        return req('DELETE', `invoicing/departments/${id}/users/${userMapId}`);
      },
    };

    // ── Reports ───────────────────────────────────────────────────────────
    this.reports = {
      summary: () => req('GET', 'invoicing/reports/summary'),
      // transactions({ format?:'csv', from?, to? }) — collections log
      transactions: (params = {}) => req('GET', `invoicing/reports/transactions?${qsOf(params)}`),
    };
  }
}

// ─── Webhooks Utility ─────────────────────────────────────────────────────
class Webhooks {
  /**
   * Verify a webhook signature from Paylode
   * Call this at the top of every webhook handler
   * @param {string|Buffer} rawBody   - Raw request body (before JSON.parse)
   * @param {string} signature        - Value of X-Paylode-Signature header
   * @param {string} secret           - Your webhook secret from the dashboard
   * @returns {boolean}
   */
  static verify(rawBody, signature, secret) {
    const hash = crypto
      .createHmac('sha512', secret)
      .update(typeof rawBody === 'string' ? rawBody : rawBody.toString())
      .digest('hex');
    return hash === signature;
  }

  /**
   * Express.js middleware — verifies signature and attaches parsed event
   * Usage: app.post('/webhook', Paylode.webhooks.middleware(secret), handler)
   */
  static middleware(secret) {
    return (req, res, next) => {
      const sig = req.headers['x-paylode-signature'];
      const raw = req.rawBody || JSON.stringify(req.body);
      if (!sig) return res.status(400).json({ error: 'Missing signature header' });
      if (!Webhooks.verify(raw, sig, secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      req.paylodeEvent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      next();
    };
  }
}

// ─── Misc Utilities ───────────────────────────────────────────────────────
function generateRef(prefix = 'TXN') {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function koboToNaira(kobo) { return (kobo / 100).toFixed(2); }
function nairaToKobo(naira) { return Math.round(naira * 100); }

// ─── Main SDK Class ───────────────────────────────────────────────────────
class Paylode {
  /**
   * @param {string} secretKey   - Your sk_live_... or sk_test_... key
   * @param {object} [options]
   * @param {boolean} [options.sandbox] - Force sandbox mode
   */
  constructor(secretKey, options = {}) {
    if (!secretKey) throw new PaylodeError('Secret key is required', 'MISSING_KEY', 0);
    if (!secretKey.startsWith('sk_live_') && !secretKey.startsWith('sk_test_')) {
      throw new PaylodeError(
        'Invalid key format. Key must start with sk_live_ or sk_test_',
        'INVALID_KEY', 0
      );
    }
    this._secretKey = secretKey;
    this.sandbox = options.sandbox || secretKey.startsWith('sk_test_');

    this.transaction  = new Transactions(secretKey);
    this.customer     = new Customers(secretKey);
    this.subaccount   = new Subaccounts(secretKey);
    this.settlement   = new Settlements(secretKey);
    this.invoicing    = new Invoicing(secretKey);
  }

  get version() { return SDK_VERSION; }
  get kycLimits() { return KYC_LIMITS; }

  /** Static webhook utilities — no instance needed */
  static get webhooks() { return Webhooks; }

  /** Utility helpers */
  static get utils() {
    return { generateRef, koboToNaira, nairaToKobo };
  }
}

module.exports = Paylode;
module.exports.PaylodeError = PaylodeError;
module.exports.KYC_LIMITS = KYC_LIMITS;
