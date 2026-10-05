'use strict';
// One-shot migration: encrypt existing plain-text NIN and BVN in mw_members.
// Run with: node backend/scripts/encrypt-kyc-fields.js
// Requires MEMBER_KYC_KEY env var (64 hex chars = 32 bytes AES-256 key).
// Safe to re-run: already-encrypted values (starting with 'v1:') are skipped.

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const KEY_HEX = process.env.MEMBER_KYC_KEY;
if (!KEY_HEX || KEY_HEX.length !== 64) {
  console.error('MEMBER_KYC_KEY env var must be 64 hex characters (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const KEY  = Buffer.from(KEY_HEX, 'hex');
const ALGO = 'aes-256-gcm';

function encrypt(val) {
  const iv  = crypto.randomBytes(12);
  const c   = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([c.update(String(val), 'utf8'), c.final()]);
  return `v1:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text AS id, nin, bvn FROM mw_members WHERE nin IS NOT NULL OR bvn IS NOT NULL`);

    let updated = 0, skipped = 0, errors = 0;

    for (const row of rows) {
      const ninPlain = row.nin && !String(row.nin).startsWith('v1:') ? row.nin : null;
      const bvnPlain = row.bvn && !String(row.bvn).startsWith('v1:') ? row.bvn : null;

      if (!ninPlain && !bvnPlain) { skipped++; continue; }

      try {
        const sets = []; const vals = [];
        if (ninPlain) { sets.push(`nin=$${vals.length+1}`); vals.push(encrypt(ninPlain)); }
        if (bvnPlain) { sets.push(`bvn=$${vals.length+1}`); vals.push(encrypt(bvnPlain)); }
        vals.push(row.id);
        await prisma.$executeRawUnsafe(
          `UPDATE mw_members SET ${sets.join(',')} WHERE id=$${vals.length}::uuid`, ...vals);
        updated++;
        if (updated % 100 === 0) console.log(`  … ${updated} rows encrypted`);
      } catch (e) {
        console.error(`Row ${row.id} failed: ${e.message}`);
        errors++;
      }
    }

    console.log(`Done. Encrypted: ${updated}, already encrypted/null: ${skipped}, errors: ${errors}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
