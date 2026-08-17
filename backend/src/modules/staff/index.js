'use strict';
const router = require('express').Router();

router.use('/admin',   require('./routes/admin'));
router.use('/',        require('./routes/clients'));

module.exports = router;
