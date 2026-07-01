'use strict';
/**
 * Member Wallet — module router. Closed-loop, merchant-owned, white-label.
 * Mounted in server.js:  app.use('/api/v1/wallet', require('./modules/wallet'))
 * Tenant = merchant (API key / owner JWT) or departmental sub-user (maker).
 */
const router = require('express').Router();

router.use('/public',   require('./routes/public'));   // UNAUTH: opted-in club directory (self-registration)
router.use('/admin',    require('./routes/admin'));    // SA: approve/reject enablement
router.use('/config',   require('./routes/config'));
router.use('/members',  require('./routes/members'));
router.use('/me',       require('./routes/me'));       // member self-service (app)
router.use('/fund',     require('./routes/fund'));
router.use('/spend',    require('./routes/spend'));
router.use('/loads',    require('./routes/loads'));
router.use('/reports',  require('./routes/reports'));

module.exports = router;
