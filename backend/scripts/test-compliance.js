'use strict';
/**
 * Offline unit checks for the Mastercard Rules compliance engine.
 * Stubs ../utils/db so the pure screening logic runs without a DB / prisma client.
 *   node scripts/test-compliance.js
 */
const path = require('path');

// Inject a no-op prisma so complianceService can be required without @prisma/client.
const dbPath = require.resolve(path.join(__dirname, '../src/utils/db'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { prisma: {} } };

const rules = require('../src/config/complianceRules');
const sanctions = require('../src/data/sanctionsList');
const c = require('../src/services/complianceService');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name); } }

console.log('\n# complianceRules.evaluate (scope matrix)');
{
  const cleanLocal = rules.evaluate('local', '5411', 'grocery store'); // 5411 not in catalogue
  check('clean local grocery → no findings', cleanLocal.length === 0);

  const gamblingLocal = rules.evaluate('local', '7995', 'sports betting');
  check('gambling local → REVIEW restricted', gamblingLocal.some(f => f.code === 'MC_RESTRICTED_MCC' && f.severity === 'REVIEW'));

  const gamblingIntl = rules.evaluate('international', '7995', 'sports betting');
  check('gambling international → BLOCKING prohibited', gamblingIntl.some(f => f.code === 'MC_PROHIBITED_MCC' && f.severity === 'BLOCKING'));

  const adult = rules.evaluate('local', '5967', 'adult content');
  check('5967 adult → BLOCKING prohibited (both scopes)', adult.some(f => f.code === 'MC_PROHIBITED_MCC'));

  const bram = rules.evaluate('local', '5411', 'we sell counterfeit designer bags');
  check('BRAM keyword "counterfeit" → BLOCKING', bram.some(f => f.code === 'MC_BRAM' && f.severity === 'BLOCKING'));

  const unknown = rules.evaluate('local', '9999', 'mystery');
  check('unknown MCC → no findings (denylist, not allowlist)', unknown.length === 0);
}

console.log('\n# sanctions list');
{
  check('exact match Kim Jong Un', !!sanctions.match('Kim Jong Un'));
  check('normalised/punct match "kim  jong-un"', !!sanctions.match('kim  jong-un'));
  check('clean name → null', sanctions.match('Ada Okeke') === null);
  check('sanctioned country IR', sanctions.isSanctionedCountry('IR') === true);
  check('non-sanctioned country NG', sanctions.isSanctionedCountry('NG') === false);
}

console.log('\n# screenMerchant');
{
  const clean = c.screenMerchant({
    applicantType: 'entity', scope: 'local', mcc: '5411',
    data: { entity_details: { registered_name: 'Lagos Foods Ltd', nature_of_business: 'grocery retail' } },
    principals: [{ first_name: 'Ada', surname: 'Okeke' }],
  });
  check('clean merchant → 0 exceptions, low risk', clean.exceptions.length === 0 && clean.riskLevel === 'low');

  const prohibited = c.screenMerchant({
    applicantType: 'entity', scope: 'international', mcc: '7995',
    data: { entity_details: { registered_name: 'BetBig', nature_of_business: 'online casino' } },
    principals: [],
  });
  check('intl gambling → BLOCKING exception + high risk', prohibited.exceptions.some(e => e.severity === 'BLOCKING') && prohibited.riskLevel === 'high');

  const sanctioned = c.screenMerchant({
    applicantType: 'natural', scope: 'local', mcc: '5411',
    data: { np_identity: { first_name: 'Kim', surname: 'Jong Un', is_pep: 'yes' } },
    principals: [],
  });
  check('sanctioned + PEP applicant → sanctionsHit + pepFlag', sanctioned.sanctionsHit && sanctioned.pepFlag);
  check('sanctions/PEP → REVIEW (deferrable) not auto-block', sanctioned.exceptions.every(e => e.code !== 'MC_SANCTIONS' || (e.severity === 'REVIEW' && e.deferrable)));

  const intlMissingEdd = c.screenMerchant({
    applicantType: 'entity', scope: 'international', mcc: '5411',
    data: { entity_details: { registered_name: 'GlobalShop', nature_of_business: 'electronics' } },
    principals: [], documents: [],
  });
  check('intl scope missing EDD docs → MC_MISSING_EDD review', intlMissingEdd.exceptions.some(e => e.code === 'MC_MISSING_EDD'));

  const match = c.screenMerchant({ applicantType: 'entity', mcc: '5411', data: {}, principals: [], matchListed: true });
  check('MATCH-listed → BLOCKING non-deferrable', match.exceptions.some(e => e.code === 'MC_MATCH' && e.severity === 'BLOCKING' && !e.deferrable));
}

console.log('\n# screenTransaction (synchronous gate)');
{
  const m = (over) => Object.assign({ mcc: '5411', cardAcceptanceScope: 'local', complianceStatus: 'clear', matchListed: false, isActive: true }, over);
  check('clean merchant → ALLOW', c.screenTransaction(m(), {}).decision === 'ALLOW');
  check('prohibited MCC → REJECT MC_PROHIBITED_MCC', c.screenTransaction(m({ mcc: '5967' }), {}).reasonCode === 'MC_PROHIBITED_MCC');
  check('gambling intl scope → REJECT', c.screenTransaction(m({ mcc: '7995', cardAcceptanceScope: 'international' }), {}).decision === 'REJECT');
  check('gambling local scope → ALLOW (restricted not prohibited)', c.screenTransaction(m({ mcc: '7995' }), {}).decision === 'ALLOW');
  check('blocked merchant → REJECT MC_BLOCKED_MERCHANT', c.screenTransaction(m({ complianceStatus: 'blocked' }), {}).reasonCode === 'MC_BLOCKED_MERCHANT');
  check('MATCH-listed → REJECT MC_MATCH', c.screenTransaction(m({ matchListed: true }), {}).reasonCode === 'MC_MATCH');
  check('sanctioned customer → REJECT MC_SANCTIONS', c.screenTransaction(m(), { customerName: 'Bashar al-Assad' }).reasonCode === 'MC_SANCTIONS');
  check('sanctioned card country → REJECT MC_SANCTIONS', c.screenTransaction(m(), { cardCountry: 'IR' }).reasonCode === 'MC_SANCTIONS');
}

console.log('\n# PCI guard');
{
  const red = c.redactPan({ card_number: '4111111111111111', amount: 500, note: '4111 1111 1111 1111' });
  check('redactPan masks card_number key', red.card_number === '[REDACTED]');
  check('redactPan masks PAN-looking value', red.note === '[REDACTED_PAN]');
  check('redactPan keeps non-PCI data', red.amount === 500);
  let threw = false;
  try { c.assertNoPan({ cvv: '123' }, 'settlement'); } catch { threw = true; }
  check('assertNoPan throws on PCI field for storage path', threw);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
