'use strict';
/**
 * Pay an Invoice & Collect invoice from a member's wallet balance — the merge of
 * invoicing + wallet. Atomic: debit wallet → record invoice payment + roll up
 * status → credit the department subsidiary ledger. The wallet can NEVER go
 * negative (moveWallet's debit check + the DB CHECK(balance>=0) both enforce it).
 */
const { prisma, genRef } = require('../_shared');
const { WalletError, moveWallet, moveDepartment } = require('./ledger');
const { lockInvoiceForUpdate, applyInvoicePayment } = require('../../invoicing/services/invoicePayHooks');

async function payInvoiceFromWallet({ walletId, invoiceId, merchantId, amount, createdBy }) {
  return prisma.$transaction(async (tx) => {
    // Invoicing owns inv_* — lock + read the invoice through its hook.
    const inv = await lockInvoiceForUpdate(tx, { invoiceId, merchantId });
    if (!inv) throw new WalletError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
    if (inv.status === 'paid') throw new WalletError('This invoice is already paid', 'ALREADY_PAID', 409);
    if (inv.status === 'cancelled') throw new WalletError('This invoice was cancelled', 'CANCELLED', 410);
    const outstanding = BigInt(inv.total_amount) - BigInt(inv.amount_paid);
    if (outstanding <= 0n) throw new WalletError('Nothing left to pay on this invoice', 'NO_BALANCE', 409);

    let pay = outstanding;
    if (amount != null) {
      pay = BigInt(amount);
      if (pay <= 0n) throw new WalletError('Invalid amount', 'INVALID_AMOUNT', 400);
      if (pay > outstanding) pay = outstanding;
      if (pay < outstanding && !inv.allow_part_payment) throw new WalletError('This invoice does not allow part payment', 'NO_PART_PAY', 400);
    }

    const ref = genRef('WLINV');
    // 1) Debit the wallet (enforces never-negative).
    const d = await moveWallet(tx, { walletId, direction: 'debit', amount: pay, type: 'invoice_payment',
      departmentId: inv.department_id || null, reference: ref, note: `Invoice ${inv.invoice_number}`, createdBy });
    // 2) Record the invoice payment + roll up status (via invoicing's hook).
    await applyInvoicePayment(tx, { invoiceId, amount: pay, reference: ref, channel: 'WALLET' });
    // 3) Credit the department subsidiary ledger (closed-loop: money stays with the dept).
    if (inv.department_id)
      await moveDepartment(tx, { merchantId, departmentId: inv.department_id, direction: 'credit', amount: pay,
        type: 'invoice', memberId: d.memberId, walletLedgerId: d.ledgerId, reference: ref });

    return { reference: ref, paid: Number(pay), wallet_balance: Number(d.balanceAfter),
      invoice_status: pay >= outstanding ? 'paid' : 'part_paid' };
  });
}

module.exports = { payInvoiceFromWallet };
