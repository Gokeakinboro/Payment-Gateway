'use strict';
/**
 * Invoice & Collect — module router. Self-contained and mounted once in server.js:
 *   app.use('/api/v1/invoicing', require('./modules/invoicing'))
 *
 * Consumed by the Paylode dashboard (JWT) and by other platforms (e.g. golf) via
 * API key — both resolve to a merchant tenant inside each subroute (see _shared.tenantAuth).
 * Public recipient/QR pay endpoints live under /public (no auth).
 */
const router = require('express').Router();

router.use('/contacts',    require('./routes/contacts'));
router.use('/lists',       require('./routes/lists'));
router.use('/formats',     require('./routes/formats'));
router.use('/products',    require('./routes/products'));
router.use('/invoices',    require('./routes/invoices'));
router.use('/qr',          require('./routes/qr'));
router.use('/links',       require('./routes/links'));
router.use('/departments', require('./routes/departments'));
router.use('/reports',     require('./routes/reports'));
router.use('/public',      require('./routes/public'));

module.exports = router;
