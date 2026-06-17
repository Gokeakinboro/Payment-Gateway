'use strict';
// Service-provider catalog — every vendor Paylode pays, the products/services
// they offer us, and THEIR price to us. Internal only (never merchant-facing).
// Costs sourced from "RAIL, FEES 2026.xlsx" (2026-06-17) — verify before relying.
// PAYIN is PalmPay's umbrella for collections → modelled as the individual
// collection products (Virtual Accounts / Pay with Transfer / Pay with Wallet).

// Payment / payout rails. `name` is matched (case-insensitive) to payment_rails
// so the dashboard can merge live status + our float.
const RAILS = [
  {
    name: 'PalmPay', sponsor: 'via sponsor bank',
    products: [
      { product: 'Payouts',           cost: '₦5 (PalmPay) · ₦12 (other banks)', kind: 'flat',     flat_naira: 12 },
      { product: 'Virtual Accounts',  cost: '0.6% capped ₦600',                 kind: 'pct_cap',  rate: 0.006, cap_naira: 600 },
      { product: 'Pay with Transfer', cost: '0.6% capped ₦600',                 kind: 'pct_cap',  rate: 0.006, cap_naira: 600 },
      { product: 'Pay with Wallet',   cost: '0.6% capped ₦600',                 kind: 'pct_cap',  rate: 0.006, cap_naira: 600 },
      { product: 'Cards',             cost: 'Not yet live',                     kind: 'na' },
    ],
  },
  {
    name: 'Parallex Bank', sponsor: 'sponsor bank',
    products: [
      { product: 'Payouts',          cost: '₦3 (Parallex) · ₦8 (other banks)', kind: 'flat',    flat_naira: 8 },
      { product: 'Cards',            cost: '0.75% capped ₦2,000',              kind: 'pct_cap', rate: 0.0075, cap_naira: 2000 },
      { product: 'Virtual Accounts', cost: '₦8',                               kind: 'flat',    flat_naira: 8 },
      { product: 'Visa',             cost: '4.5%',                             kind: 'pct',     rate: 0.045 },
      { product: 'Mastercard',       cost: '4.0%',                             kind: 'pct',     rate: 0.040 },
    ],
  },
  {
    name: 'Interswitch', sponsor: 'switch',
    products: [
      { product: 'Cards', cost: '1.5%', kind: 'pct', rate: 0.015 },
    ],
  },
];

// Screening / verification providers (KYC, AML). Costs TBD — fill once agreed.
const SCREENING = [
  { name: 'YouVerify',   type: 'KYC / Identity',  services: ['BVN', 'NIN', 'CAC', 'Address'], cost: 'TBD per check', status: 'being replaced (too expensive)' },
  { name: 'Dojah',       type: 'KYC / Identity',  services: ['BVN', 'NIN', 'CAC'],            cost: 'TBD per check', status: 'planned replacement' },
  { name: 'Interswitch', type: 'KYC',             services: ['BVN', 'NIN', 'CAC', 'TIN', 'Address'], cost: 'TBD per check', status: 'KIV (run-check)' },
  { name: 'Sanctions / PEP', type: 'AML screening', services: ['OFAC/UN/EU sanctions', 'PEP'], cost: 'TBD', status: 'placeholder list in use' },
];

module.exports = { RAILS, SCREENING };
