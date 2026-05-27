'use strict';
// ─── logger.js ────────────────────────────────────────────────────────────────
const pino = require('pino');

const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  redact: ['req.headers.authorization', 'body.password', 'body.bvn', 'body.nin',
           'body.account_number', 'body.card_number'],
});

module.exports = { logger };
