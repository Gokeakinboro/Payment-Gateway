'use strict';
/**
 * Paylode — Database Seed
 * Creates: super admin, compliance officer, sample rails, aggregator, merchants
 * Run: node prisma/seed.js
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Paylode database...\n');

  // ── 1. Super Admin ─────────────────────────────────────────────────────────
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@paylodeservices.com' },
    update: {},
    create: {
      email:        'admin@paylodeservices.com',
      passwordHash: await bcrypt.hash('Admin@Paylode2025!', 12),
      firstName:    'Paylode',
      lastName:     'Admin',
      role:         'SUPER_ADMIN',
    },
  });
  console.log('✓ Super admin:', superAdmin.email);

  // ── 2. Compliance Officer ─────────────────────────────────────────────────
  const compliance = await prisma.user.upsert({
    where: { email: 'compliance@paylodeservices.com' },
    update: {},
    create: {
      email:        'compliance@paylodeservices.com',
      passwordHash: await bcrypt.hash('Comply@Paylode2025!', 12),
      firstName:    'Amaka',
      lastName:     'Obi',
      role:         'COMPLIANCE_OFFICER',
    },
  });
  console.log('✓ Compliance officer:', compliance.email);

  // ── 3. Payment Rails ──────────────────────────────────────────────────────
  const rails = [
    { name: 'Interswitch',    status: 'CONFIG_ONLY', costs: [
      { channel: 'CARD',          rate: 0.01500, from: '2025-01-01' },
      { channel: 'USSD',          rate: 0.00800, from: '2025-01-01' },
      { channel: 'BANK_TRANSFER', rate: 0.00500, from: '2025-01-01' },
    ]},
    { name: 'NIBSS',          status: 'CONFIG_ONLY', costs: [
      { channel: 'BANK_TRANSFER', rate: 0.00300, from: '2025-01-01' },
      { channel: 'USSD',          rate: 0.00600, from: '2025-01-01' },
    ]},
    { name: 'Paystack',       status: 'CONFIG_ONLY', costs: [
      { channel: 'CARD',          rate: 0.01500, from: '2025-01-01' },
      { channel: 'BANK_TRANSFER', rate: 0.00600, from: '2025-01-01' },
    ]},
    { name: 'Flutterwave',    status: 'CONFIG_ONLY', costs: [
      { channel: 'CARD',          rate: 0.01800, from: '2025-01-01' },
      { channel: 'BANK_TRANSFER', rate: 0.00700, from: '2025-01-01' },
    ]},
    { name: 'GT Bank Direct', status: 'CONFIG_ONLY', costs: [
      { channel: 'CARD',          rate: 0.01200, from: '2025-01-01' },
      { channel: 'USSD',          rate: 0.00700, from: '2025-01-01' },
      { channel: 'BANK_TRANSFER', rate: 0.00400, from: '2025-01-01' },
    ]},
  ];

  for (const r of rails) {
    const rail = await prisma.paymentRail.upsert({
      where: { name: r.name },
      update: {},
      create: { name: r.name, status: r.status },
    });
    for (const c of r.costs) {
      await prisma.railCost.upsert({
        where: { railId_channel_effectiveFrom: {
          railId: rail.id, channel: c.channel, effectiveFrom: new Date(c.from),
        }},
        update: {},
        create: {
          railId: rail.id, channel: c.channel,
          rate: c.rate, effectiveFrom: new Date(c.from),
        },
      });
    }
  }
  console.log('✓ Payment rails + costs seeded');

  // ── 4. Aggregator ─────────────────────────────────────────────────────────
  const aggUser = await prisma.user.upsert({
    where: { email: 'agg@finconnect.ng' },
    update: {},
    create: {
      email:        'agg@finconnect.ng',
      passwordHash: await bcrypt.hash('Agg@Connect2025!', 12),
      firstName:    'Adewale',
      lastName:     'Okafor',
      role:         'AGGREGATOR',
    },
  });

  const aggregator = await prisma.aggregator.upsert({
    where: { userId: aggUser.id },
    update: {},
    create: {
      userId:           aggUser.id,
      companyName:      'FinConnect Nigeria',
      rcNumber:         'RC 1847200',
      revenueSplitPct:  0.3000,
      settlementBank:   'GTBank',
      settlementAccount:'0198765432',
      status:           'active',
    },
  });
  console.log('✓ Aggregator: FinConnect Nigeria (30% split)');

  // ── 5. Sample Merchant (via aggregator) ──────────────────────────────────
  const m1User = await prisma.user.upsert({
    where: { email: 'payments@boltnigeria.com' },
    update: {},
    create: {
      email:        'payments@boltnigeria.com',
      passwordHash: await bcrypt.hash('Bolt@Merchant2025!', 12),
      firstName:    'Bolt',
      lastName:     'Nigeria',
      role:         'MERCHANT',
    },
  });

  const merchant1 = await prisma.merchant.upsert({
    where: { merchantCode: 'MCH-BOLT-001' },
    update: {},
    create: {
      userId:            m1User.id,
      merchantCode:      'MCH-BOLT-001',
      businessName:      'Bolt Nigeria Ltd',
      businessType:      'ltd',
      category:          'Transport',
      rcNumber:          'RC 1240881',
      state:             'Lagos',
      address:           '7 Admiralty Way, Lekki Phase 1, Lagos',
      businessEmail:     'payments@boltnigeria.com',
      businessPhone:     '+234 800 000 0001',
      expectedMonthlyVol:'50to200',
      aggregatorId:      aggregator.id,
      kycStatus:         'ACTIVE',
      kycTier:           2,
      processingRate:    0.0120,  // 1.2% growth tier
      settlementBank:    'GTBank',
      settlementAccount: '0123456789',
      settlementCycle:   't1',
      isActive:          true,
      webhookSecret:     crypto.randomBytes(32).toString('hex'),
    },
  });

  // API keys for Bolt
  const liveKey = `sk_live_${crypto.randomBytes(20).toString('hex')}`;
  const testKey = `sk_test_${crypto.randomBytes(20).toString('hex')}`;
  await prisma.apiKey.createMany({
    skipDuplicates: true,
    data: [
      {
        merchantId: merchant1.id,
        keyHash:    crypto.createHash('sha256').update(liveKey).digest('hex'),
        keyPrefix:  'sk_live',
        label:      'Live Secret Key',
        isSandbox:  false,
      },
      {
        merchantId: merchant1.id,
        keyHash:    crypto.createHash('sha256').update(testKey).digest('hex'),
        keyPrefix:  'sk_test',
        label:      'Test Secret Key',
        isSandbox:  true,
      },
    ],
  });
  console.log('✓ Merchant: Bolt Nigeria (Tier 2, active, under FinConnect)');
  console.log(`  Live key: ${liveKey}`);
  console.log(`  Test key: ${testKey}`);

  // ── 6. Seed sample transactions ───────────────────────────────────────────
  const nibss = await prisma.paymentRail.findUnique({ where: { name: 'NIBSS' } });
  const interswitch = await prisma.paymentRail.findUnique({ where: { name: 'Interswitch' } });

  const sampleTxns = [
    { amount: 450000n,  channel: 'CARD',          railId: interswitch.id, status: 'SUCCESS' },
    { amount: 1280000n, channel: 'BANK_TRANSFER',  railId: nibss.id,       status: 'SUCCESS' },
    { amount: 320000n,  channel: 'USSD',           railId: interswitch.id, status: 'FAILED'  },
    { amount: 760000n,  channel: 'CARD',           railId: interswitch.id, status: 'SUCCESS' },
    { amount: 2500000n, channel: 'BANK_TRANSFER',  railId: nibss.id,       status: 'SUCCESS' },
  ];

  for (const t of sampleTxns) {
    const merchantFee = t.amount * 120n / 10000n;   // 1.2%
    const railRate = t.channel === 'CARD' ? 150n : t.channel === 'BANK_TRANSFER' ? 30n : 80n;
    const railCost = t.amount * railRate / 10000n;
    const netRevenue = merchantFee - railCost;
    const aggShare = netRevenue * 30n / 100n;

    await prisma.transaction.create({ data: {
      reference:     `TXN-SEED-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      merchantId:    merchant1.id,
      customerEmail: 'test.customer@example.com',
      amount:        t.amount,
      currency:      'NGN',
      status:        t.status,
      channel:       t.channel,
      railId:        t.railId,
      merchantFee,
      railCost,
      netRevenue:    t.status === 'SUCCESS' ? netRevenue : 0n,
      aggShare:      t.status === 'SUCCESS' ? aggShare : 0n,
      paylodeMargin: t.status === 'SUCCESS' ? netRevenue - aggShare : 0n,
      paidAt:        t.status === 'SUCCESS' ? new Date() : null,
    }});
  }
  console.log('✓ Sample transactions seeded');

  console.log('\n✅ Seed complete!\n');
  console.log('Default credentials:');
  console.log('  Super Admin:         admin@paylodeservices.com / Admin@Paylode2025!');
  console.log('  Compliance Officer:  compliance@paylodeservices.com / Comply@Paylode2025!');
  console.log('  Aggregator:          agg@finconnect.ng / Agg@Connect2025!');
  console.log('  Merchant (Bolt):     payments@boltnigeria.com / Bolt@Merchant2025!\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
