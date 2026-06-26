'use strict';
/**
 * Paylode — local sanctions / PEP reference data.
 *
 * This is a PLACEHOLDER consolidated list used for fast in-memory screening until a
 * live screening API (Interswitch marketplace / a dedicated OFAC-UN-EU feed) is wired
 * behind the same `screenName()` interface in complianceService.
 *
 * Entries are public sanctions designations kept deliberately small + representative.
 * Operators SHOULD extend the list via the SANCTIONS_NAMES env var (comma-separated)
 * and, before go-live, replace this with a real feed. Screening normalises names and
 * checks aliases so it is resilient to spacing/casing/punctuation.
 *
 * Each entry: { name, aliases[], type: 'individual'|'entity', source, country }.
 */

const SANCTIONS_ENTRIES = [
  // ── Sample OFAC SDN-style designations (public) ──
  { name: 'Kim Jong Un',            aliases: [],                              type: 'individual', source: 'OFAC', country: 'KP' },
  { name: 'Bashar al-Assad',        aliases: ['Bashar Hafez al-Assad'],      type: 'individual', source: 'OFAC', country: 'SY' },
  { name: 'Nicolas Maduro',         aliases: ['Nicolas Maduro Moros'],       type: 'individual', source: 'OFAC', country: 'VE' },
  { name: 'Islamic Revolutionary Guard Corps', aliases: ['IRGC'],            type: 'entity',     source: 'OFAC', country: 'IR' },
  { name: 'Hizballah',              aliases: ['Hezbollah', 'Hizbullah'],     type: 'entity',     source: 'OFAC', country: 'LB' },
  { name: 'Al-Qaida',               aliases: ['Al Qaeda', 'Al-Qaeda'],       type: 'entity',     source: 'UN',   country: null },
  { name: 'Islamic State of Iraq and the Levant', aliases: ['ISIL', 'ISIS', 'Daesh'], type: 'entity', source: 'UN', country: null },
  { name: 'Wagner Group',           aliases: ['PMC Wagner', 'ChVK Wagner'],  type: 'entity',     source: 'EU',   country: 'RU' },
  // SANCTIONS_NAMES env entries are appended at load time (see buildIndex()).
];

// ISO 3166-1 alpha-2 of comprehensively sanctioned / embargoed jurisdictions. Used
// for card-BIN-country screening on the transaction gate. Keep aligned with OFAC
// comprehensive programmes; tune per the operator's legal guidance.
const SANCTIONED_COUNTRIES = new Set(['KP', 'IR', 'SY', 'CU', 'RU', 'BY']);

// ── Normalisation + index ──────────────────────────────────────────────────────

// Lowercase, strip accents/punctuation, collapse whitespace → comparable token.
function normalise(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let _index = null;

function buildIndex() {
  const entries = SANCTIONS_ENTRIES.slice();

  // Append operator-supplied names from env (back-compat with the old stub).
  const envNames = (process.env.SANCTIONS_NAMES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const n of envNames) entries.push({ name: n, aliases: [], type: 'unknown', source: 'ENV', country: null });

  // Map of normalised name/alias → entry, for O(1) exact-normalised lookup, plus a
  // flat list of { norm, entry } for substring (contains) screening.
  const exact = new Map();
  const tokens = [];
  for (const e of entries) {
    for (const variant of [e.name, ...(e.aliases || [])]) {
      const norm = normalise(variant);
      if (!norm) continue;
      if (!exact.has(norm)) exact.set(norm, e);
      tokens.push({ norm, entry: e });
    }
  }
  _index = { exact, tokens, count: entries.length };
  return _index;
}

function getIndex() { return _index || buildIndex(); }

/**
 * match — screen a name against the sanctions index.
 * Returns null (clear) or { entry, matchType: 'exact'|'contains' }.
 * `contains` = the candidate contains a listed name as a whole token sequence
 * (resilient to extra words), mirroring the old substring stub but normalised.
 */
function match(name) {
  const norm = normalise(name);
  if (!norm) return null;
  const idx = getIndex();
  if (idx.exact.has(norm)) return { entry: idx.exact.get(norm), matchType: 'exact' };
  for (const { norm: listed, entry } of idx.tokens) {
    if (listed.length >= 4 && (norm.includes(listed) || listed.includes(norm))) {
      return { entry, matchType: 'contains' };
    }
  }
  return null;
}

function isSanctionedCountry(iso2) {
  return !!iso2 && SANCTIONED_COUNTRIES.has(String(iso2).toUpperCase());
}

module.exports = {
  SANCTIONS_ENTRIES, SANCTIONED_COUNTRIES,
  normalise, buildIndex, getIndex, match, isSanctionedCountry,
};
