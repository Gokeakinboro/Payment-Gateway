'use strict';
/**
 * Paylode — Mastercard Rules compliance data layer ("what NOT to do").
 *
 * Encodes the prohibitions a payment facilitator must enforce on its sub-merchants
 * and their transactions, derived from the Mastercard Rules:
 *   - BRAM (Business Risk Assessment & Mitigation) — prohibited / illegal / brand-
 *     damaging transactions.
 *   - Prohibited & restricted MCCs (Merchant Category Codes).
 *   - Transaction laundering / factoring / aggregation bans.
 *   - PCI — never store PAN/CVV.
 *
 * This file is pure data + a `scope`-aware `evaluate()`. It holds NO live calls so it
 * can be loaded on the hot path. The local-vs-international card-acceptance scope
 * matters: a category can be acceptable for local (NGN) card acceptance but
 * prohibited / registration-required for international (USD, cross-border) acceptance.
 *
 * Severity:
 *   BLOCKING — absolute prohibition; transaction/merchant must be hard-blocked.
 *              Not deferrable except by an explicit SUPER_ADMIN force-acknowledgement.
 *   REVIEW   — high-risk; allowed only after enhanced due diligence / SA review.
 *              SA may defer (with expiry) and proceed.
 *   MONITOR  — risk signal; flagged & monitored but allowed (per the Rules' monitoring-
 *              program obligation, not a real-time decline requirement).
 */

const SEVERITY = { BLOCKING: 'BLOCKING', REVIEW: 'REVIEW', MONITOR: 'MONITOR' };

// Reason / rule codes surfaced to merchants and stored on exceptions + rejections.
const REASON_CODES = {
  MC_PROHIBITED_MCC:  'MC_PROHIBITED_MCC',   // MCC is outright prohibited for the scope
  MC_RESTRICTED_MCC:  'MC_RESTRICTED_MCC',   // MCC needs enhanced DD / scheme registration
  MC_BRAM:            'MC_BRAM',             // prohibited/illegal/brand-damaging activity
  MC_SANCTIONS:       'MC_SANCTIONS',        // OFAC/UN/EU sanctions list match
  MC_PEP:             'MC_PEP',              // politically exposed person
  MC_MATCH:           'MC_MATCH',            // MATCH / terminated-merchant listing
  MC_BLOCKED_MERCHANT:'MC_BLOCKED_MERCHANT', // merchant suspended / compliance-blocked
  MC_LAUNDERING:      'MC_LAUNDERING',       // transaction laundering / aggregation pattern
  MC_VELOCITY:        'MC_VELOCITY',         // velocity anomaly
  MC_AMOUNT_ANOMALY:  'MC_AMOUNT_ANOMALY',   // amount / round-number anomaly
  MC_MISSING_EDD:     'MC_MISSING_EDD',      // enhanced due-diligence docs missing (intl)
  MC_PCI:             'MC_PCI',              // PAN/CVV handling violation
};

const SCOPES = { LOCAL: 'local', INTERNATIONAL: 'international' };

// ── MCC catalogue ────────────────────────────────────────────────────────────
// `base` = default classification (applies to both scopes unless overridden).
// `intl` = override for international card acceptance (cross-border, USD/MPGS).
// Classification: 'prohibited' | 'restricted' | 'allowed'.
// Many categories are acceptable for local acceptance but prohibited or
// registration-required cross-border under the Mastercard Rules / scheme programmes
// (e.g. gambling, quasi-cash/crypto, pharmacy, adult, telemarketing).
const MCC_CATALOGUE = {
  // ── Gambling / betting ──
  '7995': { label: 'Betting, lottery, casino & online gambling', base: 'restricted', intl: 'prohibited' },
  '7800': { label: 'Government-owned lottery', base: 'restricted', intl: 'prohibited' },
  '7801': { label: 'Government-licensed online casino (gambling)', base: 'restricted', intl: 'prohibited' },
  '7802': { label: 'Government-licensed horse/dog racing', base: 'restricted', intl: 'prohibited' },
  '9406': { label: 'Government-owned lottery (specific countries)', base: 'restricted', intl: 'prohibited' },

  // ── Quasi-cash / crypto / financial ──
  '6051': { label: 'Quasi-cash, foreign currency, crypto, money orders', base: 'restricted', intl: 'restricted' },
  '6050': { label: 'Quasi-cash — financial institution', base: 'restricted', intl: 'restricted' },
  '6211': { label: 'Securities — brokers / dealers', base: 'restricted', intl: 'restricted' },
  '6012': { label: 'Financial institution — merchandise & services', base: 'restricted', intl: 'restricted' },
  '6540': { label: 'Non-financial institution — stored value load', base: 'restricted', intl: 'restricted' },

  // ── Pharmacy / drugs ──
  '5912': { label: 'Drug stores & pharmacies', base: 'restricted', intl: 'restricted' },
  '5122': { label: 'Drugs, drug proprietaries & druggist sundries', base: 'restricted', intl: 'restricted' },

  // ── Adult / dating / teleservices ──
  '5967': { label: 'Direct marketing — inbound teleservices (adult content)', base: 'prohibited', intl: 'prohibited' },
  '7273': { label: 'Dating & escort services', base: 'restricted', intl: 'prohibited' },

  // ── Telemarketing / direct marketing ──
  '5966': { label: 'Direct marketing — outbound telemarketing', base: 'restricted', intl: 'restricted' },
  '5964': { label: 'Direct marketing — catalogue merchant', base: 'restricted', intl: 'restricted' },
  '5965': { label: 'Direct marketing — combination catalogue & retail', base: 'restricted', intl: 'restricted' },
  '5969': { label: 'Direct marketing — other', base: 'restricted', intl: 'restricted' },

  // ── Tobacco / alcohol / weapons-adjacent ──
  '5993': { label: 'Cigar stores & stands (tobacco)', base: 'restricted', intl: 'restricted' },
  '5921': { label: 'Package stores — beer, wine, liquor', base: 'restricted', intl: 'restricted' },

  // ── Digital goods / network services ──
  '4816': { label: 'Computer network / information services', base: 'restricted', intl: 'restricted' },
  '5816': { label: 'Digital goods — games', base: 'restricted', intl: 'restricted' },
  '5817': { label: 'Digital goods — applications (excl. games)', base: 'allowed', intl: 'restricted' },
  '5818': { label: 'Digital goods — large digital-goods merchant', base: 'restricted', intl: 'restricted' },

  // ── Travel (high chargeback) ──
  '5962': { label: 'Direct marketing — travel-related arrangement services', base: 'restricted', intl: 'restricted' },
  '4722': { label: 'Travel agencies & tour operators', base: 'allowed', intl: 'restricted' },

  // ── Other high-risk ──
  '9223': { label: 'Bail & bond payments', base: 'restricted', intl: 'prohibited' },
  '8651': { label: 'Political organizations', base: 'restricted', intl: 'restricted' },
  '5933': { label: 'Pawn shops', base: 'restricted', intl: 'restricted' },
};

// ── BRAM — prohibited / illegal / brand-damaging activities ───────────────────
// These are NOT legitimate MCCs; they are screened from the free-text business
// description / website. Each entry: matching keywords → a BRAM category label.
// A hit is always BLOCKING (illegal or brand-damaging under the Mastercard Rules).
const BRAM_CATEGORIES = [
  { category: 'Child sexual abuse material / exploitation',
    keywords: ['child porn', 'cp content', 'underage', 'lolita', 'preteen', 'csam'] },
  { category: 'Illegal drugs / controlled substances',
    keywords: ['buy cocaine', 'sell cocaine', 'heroin', 'methamphetamine', 'illegal drugs', 'narcotics for sale', 'mdma for sale'] },
  { category: 'Cannabis / marijuana (cross-border prohibited)',
    keywords: ['marijuana', 'cannabis', 'weed delivery', 'thc edibles', 'cbd oil'] },
  { category: 'Unlicensed pharmaceuticals / prescription without Rx',
    keywords: ['no prescription', 'without prescription', 'rx-free', 'buy adderall', 'buy oxycontin', 'buy xanax'] },
  { category: 'Weapons / firearms / explosives / ammunition',
    keywords: ['buy firearms', 'guns for sale', 'ammunition', 'explosives', 'silencers', 'automatic weapons'] },
  { category: 'Counterfeit / IP-infringing goods',
    keywords: ['replica watches', 'counterfeit', 'knockoff', 'fake designer', 'pirated software', 'cracked software'] },
  { category: 'Human trafficking / prostitution',
    keywords: ['escort service', 'prostitution', 'human trafficking', 'sex for money'] },
  { category: 'Unlawful gambling / unlicensed betting',
    keywords: ['unlicensed casino', 'illegal betting', 'underground lottery'] },
  { category: 'Unlicensed financial services / Ponzi / pyramid',
    keywords: ['ponzi', 'pyramid scheme', 'guaranteed returns', 'high-yield investment program', 'hyip', 'forex doubler'] },
  { category: 'Shell company / front for laundering',
    keywords: ['shell company', 'money laundering', 'pass-through entity'] },
  { category: 'Stolen data / hacking / fraud tooling',
    keywords: ['stolen cards', 'dumps with pin', 'cvv shop', 'carding', 'hacking service', 'fullz'] },
  { category: 'Endangered / wildlife / ivory trade',
    keywords: ['ivory', 'endangered species', 'rhino horn', 'pangolin scales'] },
];

// Flat keyword index for a fast single-pass scan (keyword → BRAM category).
const PROHIBITED_KEYWORDS = BRAM_CATEGORIES.reduce((acc, c) => {
  for (const kw of c.keywords) acc.push({ kw: kw.toLowerCase(), category: c.category });
  return acc;
}, []);

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyMcc(mcc, scope = SCOPES.LOCAL) {
  const entry = MCC_CATALOGUE[String(mcc || '').trim()];
  if (!entry) return { known: false, classification: 'allowed', label: null };
  const classification = scope === SCOPES.INTERNATIONAL && entry.intl ? entry.intl : entry.base;
  return { known: true, classification, label: entry.label };
}

function scanDescription(text) {
  const low = String(text || '').toLowerCase();
  if (!low) return [];
  const hits = [];
  for (const { kw, category } of PROHIBITED_KEYWORDS) {
    if (low.includes(kw)) hits.push({ keyword: kw, category });
  }
  return hits;
}

/**
 * evaluate — the scope-aware compliance matrix for a merchant/business.
 * Returns an array of findings: { code, severity, deferrable, description, ruleRef }.
 *  - Prohibited MCC               → BLOCKING (MC_PROHIBITED_MCC)
 *  - Restricted MCC               → REVIEW   (MC_RESTRICTED_MCC)
 *  - BRAM keyword in description   → BLOCKING (MC_BRAM)
 */
function evaluate(scope, mcc, description) {
  const findings = [];
  const useScope = scope === SCOPES.INTERNATIONAL ? SCOPES.INTERNATIONAL : SCOPES.LOCAL;

  // The MCC catalogue is a DENYLIST of high-risk codes — an MCC that is not in it is
  // presumed acceptable (no finding). Only catalogued prohibited/restricted codes flag.
  const { classification, label } = classifyMcc(mcc, useScope);
  if (classification === 'prohibited') {
    findings.push({
      code: REASON_CODES.MC_PROHIBITED_MCC, severity: SEVERITY.BLOCKING, deferrable: false,
      description: `MCC ${mcc} (${label}) is prohibited for ${useScope} card acceptance`,
      ruleRef: 'Mastercard Rules 5.x BRAM / prohibited MCC',
    });
  } else if (classification === 'restricted') {
    findings.push({
      code: REASON_CODES.MC_RESTRICTED_MCC, severity: SEVERITY.REVIEW, deferrable: true,
      description: `MCC ${mcc} (${label}) is restricted for ${useScope} acceptance — enhanced due diligence / registration required`,
      ruleRef: 'Mastercard Rules — high-risk / registered programmes',
    });
  }

  for (const hit of scanDescription(description)) {
    findings.push({
      code: REASON_CODES.MC_BRAM, severity: SEVERITY.BLOCKING, deferrable: false,
      description: `Business description matches a prohibited BRAM category: ${hit.category} (matched "${hit.keyword}")`,
      ruleRef: 'Mastercard Rules 5.x BRAM — prohibited transactions',
    });
  }

  return findings;
}

module.exports = {
  SEVERITY, REASON_CODES, SCOPES,
  MCC_CATALOGUE, BRAM_CATEGORIES, PROHIBITED_KEYWORDS,
  classifyMcc, scanDescription, evaluate,
};
