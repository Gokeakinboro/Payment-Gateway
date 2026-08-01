'use strict';
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.$connect().then(async () => {
  await p.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS kyc_yv_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id UUID,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    element VARCHAR(20) NOT NULL,
    id_number VARCHAR(100),
    yv_request_id VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    raw_response JSONB,
    triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
    triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
  )`);
  await p.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_kyc_yv_checks_merchant ON kyc_yv_checks(merchant_id)');
  await p.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_kyc_yv_checks_time ON kyc_yv_checks(merchant_id, triggered_at DESC)');
  console.log('Migration complete: kyc_yv_checks table created.');
  await p.$disconnect();
}).catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
