'use strict';
/**
 * P3 partition guard. Proves the per-service entrypoints split the monolith's
 * modules cleanly: core = everything minus products; each product service = just
 * its module; and core ∪ invoicing ∪ wallet ∪ assistant == monolith, with no
 * overlaps and no gaps. Pure module-graph check — no DB, no ports.
 *
 * Run from backend/:  node tools/p3-split-check.js
 */
const names = (svc) => Object.keys(svc.moduleHealth).sort();
const set = (a) => new Set(a);

const monolith  = names(require('../src/server'));
const core      = names(require('../src/entrypoints/core'));
const invoicing = names(require('../src/entrypoints/invoicing'));
const wallet    = names(require('../src/entrypoints/wallet'));
const assistant = names(require('../src/entrypoints/assistant'));

let failed = false;
const check = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) failed = true; };

console.log(`monolith:  ${monolith.length} modules`);
console.log(`core:      ${core.length}  (${core.filter(n => ['invoicing','wallet','assistant'].includes(n)).length} products — expect 0)`);
console.log(`invoicing: ${invoicing.join(',')}`);
console.log(`wallet:    ${wallet.join(',')}`);
console.log(`assistant: ${assistant.join(',')}\n`);

check(!core.some(n => ['invoicing','wallet','assistant'].includes(n)), 'core excludes all product modules');
check(invoicing.length === 1 && invoicing[0] === 'invoicing', 'invoicing service = [invoicing]');
check(wallet.length === 1 && wallet[0] === 'wallet', 'wallet service = [wallet]');
check(assistant.length === 1 && assistant[0] === 'assistant', 'assistant service = [assistant]');

// Union == monolith, and services are pairwise disjoint.
const union = [...core, ...invoicing, ...wallet, ...assistant];
check(union.length === new Set(union).size, 'no module appears in two services (disjoint)');
check(set(union).size === monolith.length && monolith.every(n => set(union).has(n)),
  `core ∪ products == monolith (${monolith.length})`);

console.log(failed ? '\nRESULT: SPLIT BROKEN' : '\nRESULT: SPLIT CLEAN');
process.exit(failed ? 1 : 0);
