'use strict';
const router = require('express').Router();

router.use('/admin',     require('./routes/admin'));
router.use('/prospects', require('./routes/prospects'));
router.use('/fields',    require('./routes/fields'));
router.use('/',          require('./routes/clients'));

module.exports = router;
