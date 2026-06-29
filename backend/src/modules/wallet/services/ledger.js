'use strict';
/**
 * Wallet ledger — the atomic money engine. Every balance change is one append-only
 * row carrying balance_after. All moves run inside an interactive transaction with
 * row locks (SELECT … FOR UPDATE) so concurrent operations stay consistent and the
 * float always reconciles. Closed-loop: a member can only debit toward the
 * merchant's own departments (subsidiary ledgers).
 */
const { prisma, genRef } = require('../_shared');

class WalletError extends Error {
  constructor(message, code, status = 400) { super(message); this.name = 'WalletError'; this.code = code; this.status = status; }
}

// Credit/debit a member wallet inside an open tx (locks the wallet row).
async function moveWallet(tx, { walletId, direction, amount, type, maxBalance, departmentId, transactionId, counterparty, note, createdBy, approvedBy, reference }) {
  const amt = BigInt(amount);
  if (amt <= 0n) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT', 400);
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, merchant_id::text AS merchant_id, member_id::text AS member_id,
            balance::text AS balance, status FROM wallets WHERE id = $1::uuid FOR UPDATE`, walletId);
  if (!rows.length) throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND', 404);
  const w = rows[0];
  if (w.status !== 'active') throw new WalletError('Wallet is not active', 'WALLET_INACTIVE', 409);
  const bal = BigInt(w.balance);
  let newBal;
  if (direction === 'credit') {
    newBal = bal + amt;
    if (maxBalance != null && newBal > BigInt(maxBalance))
      throw new WalletError('This would exceed the ₦' + (Number(maxBalance) / 100).toLocaleString() + ' wallet ceiling', 'MAX_BALANCE_EXCEEDED', 409);
  } else {
    if (bal < amt) throw new WalletError('Insufficient wallet balance', 'INSUFFICIENT_FUNDS', 409);
    newBal = bal - amt;
  }
  await tx.$executeRawUnsafe(`UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2::uuid`, newBal, walletId);
  const ref = reference || genRef('WL');
  const ins = await tx.$queryRawUnsafe(
    `INSERT INTO wallet_ledger (merchant_id, wallet_id, member_id, department_id, direction, amount, balance_after,
                                type, reference, transaction_id, counterparty, note, created_by, approved_by)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id::text`,
    w.merchant_id, walletId, w.member_id, departmentId || null, direction, amt, newBal, type, ref,
    transactionId || null, counterparty || null, note || null, createdBy || null, approvedBy || null);
  return { ledgerId: ins[0].id, balanceAfter: newBal, reference: ref, merchantId: w.merchant_id, memberId: w.member_id };
}

// Credit/debit a departmental subsidiary ledger inside an open tx (locks the department).
async function moveDepartment(tx, { merchantId, departmentId, direction, amount, type, memberId, walletLedgerId, reference }) {
  await tx.$queryRawUnsafe(`SELECT id FROM inv_departments WHERE id = $1::uuid AND merchant_id = $2::uuid FOR UPDATE`, departmentId, merchantId);
  const last = await tx.$queryRawUnsafe(
    `SELECT balance_after::text AS b FROM wallet_department_ledger WHERE department_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1`, departmentId);
  const cur = last.length ? BigInt(last[0].b) : 0n;
  const amt = BigInt(amount);
  const newBal = direction === 'credit' ? cur + amt : cur - amt;
  if (newBal < 0n) throw new WalletError('Insufficient department balance', 'INSUFFICIENT_DEPT_FUNDS', 409);
  await tx.$executeRawUnsafe(
    `INSERT INTO wallet_department_ledger (merchant_id, department_id, direction, amount, balance_after, type, member_id, wallet_ledger_id, reference)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9)`,
    merchantId, departmentId, direction, amt, newBal, type, memberId || null, walletLedgerId || null, reference || genRef('WD'));
  return { balanceAfter: newBal };
}

// ── Public operations ────────────────────────────────────────────────────────
function credit(params) { return prisma.$transaction((tx) => moveWallet(tx, { ...params, direction: 'credit' })); }
function debit(params)  { return prisma.$transaction((tx) => moveWallet(tx, { ...params, direction: 'debit' })); }

// Member spends into a department: debit wallet + credit dept subsidiary ledger (atomic).
function spendToDepartment({ walletId, departmentId, amount, createdBy, note }) {
  return prisma.$transaction(async (tx) => {
    const ref = genRef('WSP');
    const d = await moveWallet(tx, { walletId, direction: 'debit', amount, type: 'spend', departmentId, reference: ref, createdBy, note });
    const dep = await moveDepartment(tx, { merchantId: d.merchantId, departmentId, direction: 'credit', amount, type: 'spend', memberId: d.memberId, walletLedgerId: d.ledgerId, reference: ref });
    return { ...d, departmentBalanceAfter: dep.balanceAfter };
  });
}

// Move money between two departmental subsidiary ledgers.
function transferDepartments({ merchantId, fromDepartmentId, toDepartmentId, amount }) {
  if (fromDepartmentId === toDepartmentId) throw new WalletError('Source and destination departments must differ', 'SAME_DEPARTMENT', 400);
  return prisma.$transaction(async (tx) => {
    const ref = genRef('WDT');
    await moveDepartment(tx, { merchantId, departmentId: fromDepartmentId, direction: 'debit',  amount, type: 'transfer', reference: ref + '-O' });
    await moveDepartment(tx, { merchantId, departmentId: toDepartmentId,   direction: 'credit', amount, type: 'transfer', reference: ref + '-I' });
    return { reference: ref };
  });
}

// Reconciliation: merchant float (Σ wallet balances) vs Σ ledger movements.
async function reconcile(merchantId) {
  const r = await prisma.$queryRawUnsafe(
    `SELECT (SELECT COALESCE(SUM(balance),0) FROM wallets WHERE merchant_id=$1::uuid)::text AS wallet_float,
            (SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0)
               FROM wallet_ledger WHERE merchant_id=$1::uuid)::text AS ledger_net`, merchantId);
  const float = BigInt(r[0].wallet_float), net = BigInt(r[0].ledger_net);
  return { wallet_float: Number(float), ledger_net: Number(net), balanced: float === net };
}

module.exports = { credit, debit, spendToDepartment, transferDepartments, moveWallet, moveDepartment, reconcile, WalletError };
