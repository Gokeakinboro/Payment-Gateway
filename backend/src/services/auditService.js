'use strict';
// ─── auditService.js ──────────────────────────────────────────────────────────
const { prisma } = require('../utils/db');
const { logger }  = require('../utils/logger');

async function logAudit(actorId, action, entityType, entityId, before, after, notes, ipAddress) {
  try {
    await prisma.auditLog.create({ data: {
      actorId, action, entityType, entityId: String(entityId),
      beforeState: before || undefined,
      afterState:  after  || undefined,
      notes:       notes  || undefined,
      ipAddress:   ipAddress || undefined,
    }});
  } catch (e) {
    logger.error({ err: e }, 'Failed to write audit log');
  }
}

module.exports = { logAudit };
