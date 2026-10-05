'use strict';
/**
 * parallexAlertSync.js — cron wrapper for the Parallex alert IMAP reader.
 * Runs every 15 minutes via pm2 cron_restart.
 *
 * PM2 ecosystem entry:
 *   { name: 'parallex-alert-sync', script: 'src/cron/parallexAlertSync.js',
 *     exec_mode: 'fork', instances: 1,
 *     cron_restart: '* /15 * * * *', autorestart: false,
 *     env: { NODE_ENV: 'production' } }
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { syncParallexAlerts } = require('../services/parallexAlertReader');
const { prisma }             = require('../utils/db');

const log = (msg) => console.log('[parallex-alert-sync]', new Date().toISOString(), msg);

syncParallexAlerts()
  .then(({ fetched, stored, matched }) => {
    log(`Done — fetched=${fetched} stored=${stored} matched=${matched}`);
  })
  .catch(e => {
    log('ERROR: ' + e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
