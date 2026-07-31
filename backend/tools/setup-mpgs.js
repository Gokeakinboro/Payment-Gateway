'use strict';
// One-shot script: configure Drinks Arena MPGS credentials via local API
// Run on server 176: node /tmp/setup-mpgs.js

const http = require('http');

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: 3000, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

function put(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: 3000, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
                 'Authorization': `Bearer ${token}` } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  console.log('1. Logging in as SA...');
  const login = await post('/api/v1/auth/login', { email: 'gokeakinboro@gmail.com', password: 'paylodewallet2026' });
  if (!login.status) { console.error('Login failed:', login.message); process.exit(1); }
  const token = login.data.token;
  console.log('   OK — token issued');

  console.log('2. Configuring MPGS for Drinks Arena (MCH-D2BDE033)...');
  const cfg = await put('/api/v1/mpgs/admin/7548c579-a281-49cf-9ea5-b5ec87fe3f28', {
    mpgs_mid:          'PSLPBL1',
    mpgs_api_password: '@Sulaimon+1@',
    mpgs_base_url:     'https://na-gateway.mastercard.com/api/rest/version/77',
    notes:             'Drinks Arena — Parallex MPGS prod config 2026-07-24',
  }, token);

  console.log('   Status:', cfg.status, cfg.message);
  if (cfg.data) {
    console.log('   MPGS MID:            ', cfg.data.mpgs_mid);
    console.log('   Gateway URL:         ', cfg.data.connection_parameters?.gateway_url);
    console.log('\n   ⚠️  GATEWAY PASSWORD (show once — save securely):');
    console.log('  ', cfg.data.gateway_api_password);
    console.log('\n   Share these with DrinksArena:');
    console.log('   Gateway URL:', cfg.data.connection_parameters?.gateway_url);
    console.log('   Merchant ID:', cfg.data.connection_parameters?.merchant_id);
    console.log('   API Password:', cfg.data.gateway_api_password);
  } else {
    console.error('   Error:', JSON.stringify(cfg));
  }
})();
