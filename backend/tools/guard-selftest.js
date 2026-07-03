'use strict';
/**
 * P1a behavior self-test: proves the two new guarantees of the module registry,
 * end-to-end over real HTTP (no mocking of express).
 *
 *   1) A module that throws on load does NOT crash the app — its path serves
 *      503 MODULE_UNAVAILABLE and sibling modules keep working.
 *   2) A module toggled off (enabledEnv=off) is skipped (unmounted → 404) and
 *      recorded as 'disabled'.
 *
 * Run from backend/:  node tools/guard-selftest.js
 */
const express = require('express');
const { mountModules } = require('../src/modules/registry');

const okRouter = () => {
  const r = express.Router();
  r.get('/', (req, res) => res.json({ status: true, from: 'good' }));
  return r;
};

// Synthetic registry: a healthy module, a broken one, and a toggled-off one.
process.env.TEST_TOGGLED_ENABLED = 'off';
const modules = [
  { name: 'good',    basePath: '/api/test/good',    load: okRouter,                              enabledEnv: 'TEST_GOOD_ENABLED',    category: 'test' },
  { name: 'broken',  basePath: '/api/test/broken',  load: () => { throw new Error('boom at load'); }, enabledEnv: 'TEST_BROKEN_ENABLED',  category: 'test' },
  { name: 'toggled', basePath: '/api/test/toggled', load: okRouter,                              enabledEnv: 'TEST_TOGGLED_ENABLED', category: 'test' },
];

const app = express();
const health = {};
mountModules(app, { health, modules, logger: null });
app.use((req, res) => res.status(404).json({ status: false, error_code: 'NOT_FOUND' }));

const assert = (cond, msg) => { if (!cond) { console.log('✗ ' + msg); process.exitCode = 1; } else { console.log('✓ ' + msg); } };

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };
  try {
    // Health map assertions
    assert(health.good.status === 'ok',        `good module recorded ok (got ${health.good.status})`);
    assert(health.broken.status === 'failed',  `broken module recorded failed (got ${health.broken.status})`);
    assert(/boom at load/.test(health.broken.error || ''), 'broken module captured the load error');
    assert(health.toggled.status === 'disabled', `toggled module recorded disabled (got ${health.toggled.status})`);

    // HTTP behavior assertions
    const good = await get('/api/test/good');
    assert(good.code === 200 && good.body.from === 'good', 'good module serves 200 (siblings unaffected by the broken one)');

    const broken = await get('/api/test/broken');
    assert(broken.code === 503 && broken.body.error_code === 'MODULE_UNAVAILABLE', `broken module serves 503 MODULE_UNAVAILABLE (got ${broken.code}/${broken.body.error_code})`);

    const toggled = await get('/api/test/toggled');
    assert(toggled.code === 404, `toggled-off module is unmounted → 404 (got ${toggled.code})`);
  } catch (e) {
    console.log('✗ self-test threw: ' + e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: ALL GUARANTEES HOLD');
  }
});
