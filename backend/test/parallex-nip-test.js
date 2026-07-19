'use strict';
// Quick one-shot test: fire the Parallex interbank transfer payload exactly as-given.
// Run from backend/: node test/parallex-nip-test.js
// Uses same PARALLEX_TRANSFER_* env as parallexTransferService.js.
require('dotenv').config();

const BASE_URL      = (process.env.PARALLEX_TRANSFER_BASE_URL || 'https://parallex-apim.azure-api.net/thirdpartytransfer').replace(/\/$/, '');
const USERNAME      = process.env.PARALLEX_TRANSFER_USERNAME || '';
const PASSWORD      = process.env.PARALLEX_TRANSFER_PASSWORD || '';
const SUBKEY        = process.env.PARALLEX_TRANSFER_SUBKEY   || '';
const SUBKEY_HEADER = process.env.PARALLEX_TRANSFER_SUBKEY_HEADER || 'Ocp-Apim-Subscription-Key';

function headers(tok) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (SUBKEY) h[SUBKEY_HEADER] = SUBKEY;
  if (tok)    h['Authorization'] = 'Bearer ' + tok;
  return h;
}

async function login() {
  console.log('\n[1] Logging in as', USERNAME, '...');
  const res = await fetch(BASE_URL + '/api/ThirdPartyTransfer/Login', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const r = await res.json();
  console.log('    Login response:', JSON.stringify(r, null, 2));
  if (!r.token) throw new Error('Login failed — no token');
  return r.token;
}

async function sendInterbank(tok) {
  // Exact payload from the user — testing as-is.
  const payload = {
    accountToDebit: '1000111700',
    channel: '0',
    interTransferDetails: [
      {
        amount: '500',
        beneficiaryAccountName: 'CEMC ABUJA LWUSA',
        beneficiaryAccountNumber: '2030070786',
        beneficiaryBankCode: '999998',
        nameEnquirySessionID: '379992268455626366377760672676',
        transactionReference: 'AS38494830',
        beneficiaryBVN: '11111111111',
        beneficiaryKYC: '0',
        beneficiaryBankName: 'bank',
        customerRemark: '',
      },
    ],
    transactionLocation: 'Port harcourt',
    userName: 'pet',
  };

  console.log('\n[2] POST /InterbankTransfer ...');
  console.log('    Payload:', JSON.stringify(payload, null, 2));

  const res = await fetch(BASE_URL + '/api/ThirdPartyTransfer/InterbankTransfer', {
    method: 'POST', headers: headers(tok),
    body: JSON.stringify(payload),
  });
  const r = await res.json().catch(() => ({ parseError: true, status: res.status }));
  console.log('\n[2] Response (HTTP', res.status + '):');
  console.log(JSON.stringify(r, null, 2));
  return r;
}

(async () => {
  if (!USERNAME || !PASSWORD || !SUBKEY) {
    console.error('Missing PARALLEX_TRANSFER_USERNAME / _PASSWORD / _SUBKEY in env.');
    process.exit(1);
  }
  try {
    const tok = await login();
    await sendInterbank(tok);
  } catch (e) {
    console.error('\nERROR:', e.message);
    process.exit(1);
  }
})();
