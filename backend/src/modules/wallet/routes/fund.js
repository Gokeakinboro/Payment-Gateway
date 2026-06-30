'use strict';
// Fund a wallet via the hosted checkout page. Mints a PENDING transaction tagged
// source=wallet_fund and returns checkout.html?ref — the member pays and the
// wallet is credited instantly on SUCCESS (see services/walletFund + payinFinalize).
const router = require('express').Router();
const { prisma, tenantAuth, requireWalletEnabled, getConfig } = require('../_shared');
const { ok, fail, created, notFound, generateRef } = require('../../../utils/helpers');
const compliance = require('../../../services/complianceService');

const CHECKOUT_BASE = (process.env.CHECKOUT_BASE_URL || 'https://paylodeservices.com').replace(/\/$/, '');

router.use(tenantAuth, requireWalletEnabled);

// POST /:walletId  body: { amount(kobo) }
router.post('/:walletId', async (req, res, next) => {
  try {
    const mid = req.walletTenant.merchantId;
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 10000) return fail(res, 'amount must be in kobo, minimum ₦100 (10000 kobo)');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT w.id::text AS wallet_id, w.balance::text AS balance, w.status AS wallet_status,
              m.id::text AS member_id, m.name, m.email, m.status AS member_status
         FROM mw_wallets w JOIN mw_members m ON m.id = w.member_id
        WHERE w.id = $1::uuid AND w.merchant_id = $2::uuid`, req.params.walletId, mid);
    if (!rows.length) return notFound(res, 'Wallet');
    const w = rows[0];
    if (w.wallet_status !== 'active' || w.member_status !== 'active') return fail(res, 'This wallet cannot be funded', 'WALLET_INACTIVE', 409);

    const cfg = await getConfig(mid);
    if (BigInt(w.balance) + BigInt(amount) > cfg.max_balance)
      return fail(res, `Funding would exceed the ₦${(Number(cfg.max_balance) / 100).toLocaleString()} wallet ceiling`, 'MAX_BALANCE_EXCEEDED', 409);

    const merchant = await prisma.merchant.findUnique({ where: { id: mid }, include: { aggregator: true } });
    if (!merchant || !merchant.isActive) return fail(res, 'This merchant cannot currently accept payments', 'MERCHANT_INACTIVE', 403);
    const gate = compliance.screenTransaction(merchant, { customerEmail: w.email || undefined });
    if (gate.decision === 'REJECT') return fail(res, gate.message, gate.reasonCode, 403);

    const ref = generateRef('WLTFUND');
    await prisma.transaction.create({ data: {
      reference: ref, merchantId: mid, customerEmail: w.email || '',
      amount: BigInt(amount), currency: 'NGN', status: 'PENDING', channel: 'CARD',
      authUrl: `${CHECKOUT_BASE}/checkout.html?ref=${ref}`, accessCode: ref, isSandbox: false,
      metadata: { description: `Wallet top-up for ${w.name}`, source: 'wallet_fund', wallet_id: w.wallet_id, member_id: w.member_id },
    }});
    return created(res, { reference: ref, redirect_url: `${CHECKOUT_BASE}/checkout.html?ref=${ref}` }, 'Funding started');
  } catch (e) { next(e); }
});

module.exports = router;
