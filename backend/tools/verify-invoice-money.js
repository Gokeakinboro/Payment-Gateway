'use strict';
/**
 * Money-math check for computeInvoiceMoney (itemized invoices / QR / links).
 * Asserts the service-charge + VAT-exempt formula against hand-computed cases.
 * Run from backend/:  node tools/verify-invoice-money.js
 */
process.env.INVOICE_VAT_RATE = process.env.INVOICE_VAT_RATE || '0.075';
const { computeInvoiceMoney } = require('../src/modules/invoicing/_shared');

const items = [
  { name: 'Beer', unit_amount: 10000, quantity: 2 },  // 20000
  { name: 'Wine', unit_amount: 5000,  quantity: 1 },  // 5000
]; // subtotal 25000; 7.5% VAT on 25000 = 1875; 10% service on 25000 = 2500

let failed = false;
const eq = (got, want, label) => {
  const ok = got === want;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}: got ${got}${ok ? '' : `  want ${want}`}`);
  if (!ok) failed = true;
};

function check(name, opts, want) {
  console.log(name);
  const r = computeInvoiceMoney({ items, ...opts });
  if (r.error) { console.log('  ✗ unexpected error: ' + r.error); failed = true; return; }
  eq(r.itemsSubtotal, want.sub, 'itemsSubtotal');
  eq(r.serviceCharge, want.svc, 'serviceCharge');
  eq(r.vatAmount, want.vat, 'vatAmount');
  eq(r.amount, want.amount, 'amount(excl VAT)');
  eq(r.total, want.total, 'total');
}

check('1) service 10% ON + VAT ON', { serviceChargePct: 10, applyServiceCharge: true, chargeVat: true },
  { sub: 25000, svc: 2500, vat: 1875, amount: 27500, total: 29375 });
check('2) service OFF + VAT ON', { serviceChargePct: 10, applyServiceCharge: false, chargeVat: true },
  { sub: 25000, svc: 0, vat: 1875, amount: 25000, total: 26875 });
check('3) service 10% ON + VAT OFF', { serviceChargePct: 10, applyServiceCharge: true, chargeVat: false },
  { sub: 25000, svc: 2500, vat: 0, amount: 27500, total: 27500 });
check('4) both OFF', { serviceChargePct: 10, applyServiceCharge: false, chargeVat: false },
  { sub: 25000, svc: 0, vat: 0, amount: 25000, total: 25000 });

// KEY: VAT must be on the item subtotal (25000), NOT on amount incl service (27500).
console.log('5) VAT-exempt service (VAT base excludes the 2500 service charge)');
const r5 = computeInvoiceMoney({ items, serviceChargePct: 10, applyServiceCharge: true, chargeVat: true });
eq(r5.vatAmount, 1875, 'vat on items only (not 2062 on 27500)');

// Guards
console.log('6) limit + validation guards');
eq(computeInvoiceMoney({ items: [], chargeVat: true }).error ? 1 : 0, 1, 'empty items rejected');
eq(computeInvoiceMoney({ items: Array(16).fill({ name: 'x', unit_amount: 100, quantity: 1 }), maxItems: 15 }).error ? 1 : 0, 1, '>15 items rejected');
eq(computeInvoiceMoney({ items: [{ name: '', unit_amount: 100, quantity: 1 }] }).error ? 1 : 0, 1, 'missing name rejected');
eq(computeInvoiceMoney({ items: [{ name: 'x', unit_amount: -1, quantity: 1 }] }).error ? 1 : 0, 1, 'negative amount rejected');
// legacy {description, amount} still works
const rl = computeInvoiceMoney({ items: [{ description: 'Old', amount: 5000 }] });
eq(rl.error ? 1 : rl.amount, 5000, 'legacy {description,amount} → amount 5000');

console.log(failed ? '\nRESULT: MONEY MATH BROKEN' : '\nRESULT: INVOICE MONEY MATH OK');
process.exit(failed ? 1 : 0);
