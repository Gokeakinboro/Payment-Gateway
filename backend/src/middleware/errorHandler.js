'use strict';
const { logger } = require('../utils/logger');

module.exports = function errorHandler(err, req, res, next) {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  // Prisma errors
  if (err.code === 'P2002')
    return res.status(409).json({ status: false, message: 'Duplicate entry — this record already exists', error_code: 'DUPLICATE' });
  if (err.code === 'P2025')
    return res.status(404).json({ status: false, message: 'Record not found', error_code: 'NOT_FOUND' });

  // Validation errors
  if (err.name === 'ValidationError')
    return res.status(400).json({ status: false, message: err.message, error_code: 'VALIDATION_ERROR' });

  // JWT errors
  if (err.name === 'JsonWebTokenError')
    return res.status(401).json({ status: false, message: 'Invalid token', error_code: 'INVALID_TOKEN' });

  // Default 500
  const isProd = process.env.NODE_ENV === 'production';
  res.status(500).json({
    status: false,
    message: isProd ? 'An internal error occurred. Our team has been notified.' : err.message,
    error_code: 'INTERNAL_ERROR',
    ...(isProd ? {} : { stack: err.stack }),
  });
};
