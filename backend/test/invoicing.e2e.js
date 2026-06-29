'use strict';
/**
 * Invoice & Collect — sandbox end-to-end smoke test (real HTTP, against a deployed
 * environment). Drives the module through the published Node SDK exactly as an
 * external platform (e.g. the golf platform) would.
 *
 * Run AFTER deploy:
 *   PAYLODE_TEST_KEY=sk_test_xxx node test/invoicing.e2e.js
 *   PAYLODE_API_HOST=api.sandbox.paylodeservices.com PAYLODE_TEST_KEY=sk_test_xxx node test/invoicing.e2e.js
 *
 * Skips (exit 0) when PAYLODE_TEST_KEY is absent, so it is safe in CI without creds.
 */
const key = process.env.PAYLODE_TEST_KEY;
if (!key) {
  console.log('  ⏭  invoicing e2e skipped (set PAYLODE_TEST_KEY=sk_test_… to run)\n');
  process.exit(0);
}

// Optional host override for a dedicated sandbox vhost.
if (process.env.PAYLODE_API_HOST) {
  const Module = require('module');
  const sdkPath = require.resolve('../../sdk/src/paylode.js');
  const orig = Module.prototype.require;
  // Lightweight host patch: rewrite the SDK's BASE_URL constant at load.
  const fs = require('fs');
  let src = fs.readFileSync(sdkPath, 'utf8')
    .replace(/const BASE_URL = '[^']+';/, `const BASE_URL = '${process.env.PAYLODE_API_HOST}';`);
  const m = new Module(sdkPath, module);
  m._compile(src, sdkPath);
  require.cache[sdkPath] = m;
  void orig;
}

const Paylode = require('../../sdk/src/paylode.js');
const paylode = new Paylode(key);

let step = 0;
const log = (msg) => console.log(`  ${String(++step).padStart(2, '0')}  ${msg}`);

(async () => {
  console.log('\n  Invoice & Collect — sandbox e2e\n');
  try {
    // 1. Branding format round-trip
    await paylode.invoicing.format.update({ layout: 'modern', charge_vat_default: true });
    log('format.update → ok');

    // 2. Contact → list
    const c = await paylode.invoicing.contacts.create({
      name: 'E2E Member', email: `e2e+${Date.now()}@example.com`, phone: '+2348000000000',
    });
    const contactId = c.data.id;
    log(`contacts.create → ${contactId}`);

    const list = await paylode.invoicing.lists.create({ name: `E2E List ${Date.now()}`, contact_ids: [contactId] });
    log(`lists.create → ${list.data.id}`);

    // 3. Invoice to that contact, with VAT
    const inv = await paylode.invoicing.invoices.create({
      amount: 5_000_000, description: 'E2E membership', charge_vat: true,
      recipients: { contact_id: contactId },
    });
    const invoiceId = inv.data.invoices[0].id;
    log(`invoices.create → ${inv.data.invoices[0].invoice_number} (${invoiceId})`);

    const fetched = await paylode.invoicing.invoices.fetch(invoiceId);
    assert(fetched.data.total_amount === 5_375_000, `expected total 5,375,000 got ${fetched.data.total_amount}`);
    log('invoices.fetch → total includes 7.5% VAT ✓');

    // 4. QR (fixed + open)
    const qrFixed = await paylode.invoicing.qr.create({ type: 'fixed', amount: 250000, label: 'E2E range balls' });
    log(`qr.create fixed → ${qrFixed.data.id}`);
    const qrOpen = await paylode.invoicing.qr.create({ type: 'open', label: 'E2E pro shop' });
    log(`qr.create open → ${qrOpen.data.id}`);

    // 5. Reports
    const sum = await paylode.invoicing.reports.summary();
    log(`reports.summary → ${JSON.stringify(sum.data.by_status)}`);

    // 6. Cleanup
    await paylode.invoicing.invoices.cancel(invoiceId);
    await paylode.invoicing.qr.remove(qrFixed.data.id);
    await paylode.invoicing.qr.remove(qrOpen.data.id);
    await paylode.invoicing.lists.remove(list.data.id);
    await paylode.invoicing.contacts.remove(contactId);
    log('cleanup → cancelled invoice, removed QR/list/contact');

    console.log('\n  ✅  e2e passed\n');
  } catch (e) {
    console.error(`\n  ❌  e2e failed at step ${step}: ${e.code || ''} ${e.message}`);
    if (e.raw) console.error('     raw:', JSON.stringify(e.raw));
    process.exit(1);
  }
})();

function assert(cond, msg) { if (!cond) throw new Error(msg); }
