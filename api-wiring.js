// ─────────────────────────────────────────────────────────────────────────────
// PAYLODE — Live API Wiring
// Overrides all hardcoded render functions with live API data
// ─────────────────────────────────────────────────────────────────────────────

function getToken(){ return sessionStorage.getItem('paylode_token'); }
function getUser(){ try{ return JSON.parse(sessionStorage.getItem('paylode_user')||'{}'); }catch(e){ return {}; } }
function logout(){
  sessionStorage.removeItem('paylode_token');
  sessionStorage.removeItem('paylode_user');
  sessionStorage.removeItem('paylode_selected_role');
  window.location.href='/index.html';
}


// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtNaira(kobo) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(Number(kobo) / 100);
}
// Format a MAJOR-unit amount (already divided by 100) in the given currency.
function fmtMajor(major, ccy) {
  ccy = (ccy === 'USD') ? 'USD' : 'NGN';
  return new Intl.NumberFormat(ccy === 'USD' ? 'en-US' : 'en-NG',
    { style: 'currency', currency: ccy, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(major) || 0);
}
// Format a MINOR-unit amount (kobo/cents) in the given currency.
function fmtMoney(minor, ccy) { return fmtMajor((Number(minor) || 0) / 100, ccy); }
// Small badge marking an international (USD) line wherever it appears.
function intlBadge() { return '<span class="badge badge-blue" style="font-size:10px">🌍 Int\'l · USD</span>'; }
function ccyChip(ccy) {
  return ccy === 'USD'
    ? '<span class="badge badge-blue" style="font-size:10px">$ USD</span>'
    : '<span class="badge badge-gray" style="font-size:10px">₦ NGN</span>';
}
function fmtNum(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return (n||0).toLocaleString();
}
function statusBadge(s) {
  const map = { success:'badge-green', failed:'badge-red', pending:'badge-amber', reversed:'badge-purple', active:'badge-green', suspended:'badge-red', kyc_approved:'badge-green', pending_kyc:'badge-amber', kyc_in_review:'badge-blue', kyc_rejected:'badge-red' };
  return `<span class="badge ${map[s?.toLowerCase()]||'badge-gray'}">${s||'—'}</span>`;
}
function loading() {
  return `<div style="text-align:center;padding:40px;color:var(--gray-400)">
    <div style="font-size:24px;margin-bottom:8px">⟳</div>Loading live data...</div>`;
}
function errorBox(msg) {
  return `<div class="warn-box">⚠ ${msg}</div>`;
}

// ── SUPER ADMIN OVERVIEW ──────────────────────────────────────────────────────
async function loadSuperOverview() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const [dash, txns] = await Promise.all([
      apiFetch('/admin/dashboard'),
      apiFetch('/transactions?perPage=8&page=1'),
    ]);

    if (!dash?.data) { el.innerHTML = errorBox('Could not load dashboard data'); return; }
    const d = dash.data;
    const rows = txns?.data?.data || [];

    // Currency-separated blocks (fall back to legacy NGN-only shape if needed)
    const tNGN = (d.today_by_currency && d.today_by_currency.NGN) || d.today || {txn_count:0,volume:0,fees:0,paylode_net:0};
    const tUSD = (d.today_by_currency && d.today_by_currency.USD) || {txn_count:0,volume:0,fees:0,paylode_net:0};
    const mNGN = (d.mtd_by_currency && d.mtd_by_currency.NGN) || d.mtd || {txn_count:0,volume:0,fees:0,paylode_net:0};
    const mUSD = (d.mtd_by_currency && d.mtd_by_currency.USD) || {txn_count:0,volume:0,fees:0,paylode_net:0};

    // A money cell that shows the amount in its own currency
    const txnAmt = (t) => fmtMoney(t.amount, t.currency);

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Platform Overview</div>
      <div class="page-desc">Live data — ${new Date().toLocaleDateString('en-NG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
    </div>

    <!-- LOCAL (NGN) block -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span class="badge badge-gray">₦ Local (NGN)</span>
      <span style="font-size:12px;color:var(--gray-400)">Local cards, virtual accounts, USSD &amp; payouts</span>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--lime)"></span>Today Volume</div>
        <div class="stat-value">${fmtMajor(tNGN.volume,'NGN')}</div>
        <div class="stat-sub">${fmtNum(tNGN.txn_count)} transactions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>Today Net Revenue</div>
        <div class="stat-value">${fmtMajor(tNGN.paylode_net,'NGN')}</div>
        <div class="stat-sub">Fees: ${fmtMajor(tNGN.fees,'NGN')}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--purple)"></span>Active Merchants</div>
        <div class="stat-value">${fmtNum(d.active_merchants)}</div>
        <div class="stat-sub">${d.kyc_pending} pending KYC</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--green)"></span>Aggregators</div>
        <div class="stat-value">${fmtNum(d.active_aggregators)}</div>
        <div class="stat-sub">Active partners</div>
      </div>
    </div>

    <!-- INTERNATIONAL (USD) block — always shown, separate -->
    <div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span class="badge badge-blue">🌍 International (USD)</span>
      <span style="font-size:12px;color:var(--gray-400)">International card transactions — settled in US Dollars</span>
    </div>
    <div class="stats-grid">
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>Today USD Volume</div>
        <div class="stat-value">${fmtMajor(tUSD.volume,'USD')}</div>
        <div class="stat-sub">${fmtNum(tUSD.txn_count)} intl transactions</div>
      </div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>Today USD Net Revenue</div>
        <div class="stat-value">${fmtMajor(tUSD.paylode_net,'USD')}</div>
        <div class="stat-sub">Fees: ${fmtMajor(tUSD.fees,'USD')}</div>
      </div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>MTD USD Volume</div>
        <div class="stat-value">${fmtMajor(mUSD.volume,'USD')}</div>
        <div class="stat-sub">${fmtNum(mUSD.txn_count)} this month</div>
      </div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>MTD USD Margin</div>
        <div class="stat-value">${fmtMajor(mUSD.paylode_net,'USD')}</div>
        <div class="stat-sub">Fees: ${fmtMajor(mUSD.fees,'USD')}</div>
      </div>
    </div>

    <div class="grid-2 section-gap">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Month to Date</div><div class="card-subtitle">Current month — local &amp; international shown separately</div></div>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">₦ Local (NGN)</div>
        <div class="rev-row"><span class="rev-label">Total Volume</span><span class="rev-value">${fmtMajor(mNGN.volume,'NGN')}</span></div>
        <div class="rev-row"><span class="rev-label">Gross Fees</span><span class="rev-value">${fmtMajor(mNGN.fees,'NGN')}</span></div>
        <div class="rev-row"><span class="rev-label">Transactions</span><span class="rev-value">${fmtNum(mNGN.txn_count)}</span></div>
        <div class="rev-net">
          <span style="font-weight:600;font-size:13px;color:#166534">Net Margin (NGN)</span>
          <span style="font-weight:800;font-size:18px;color:#166534">${fmtMajor(mNGN.paylode_net,'NGN')}</span>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 4px">🌍 International (USD)</div>
        <div class="rev-row"><span class="rev-label">Total Volume</span><span class="rev-value">${fmtMajor(mUSD.volume,'USD')}</span></div>
        <div class="rev-row"><span class="rev-label">Gross Fees</span><span class="rev-value">${fmtMajor(mUSD.fees,'USD')}</span></div>
        <div class="rev-row"><span class="rev-label">Transactions</span><span class="rev-value">${fmtNum(mUSD.txn_count)}</span></div>
        <div class="rev-net" style="background:#eff6ff;border-color:#bfdbfe">
          <span style="font-weight:600;font-size:13px;color:#1e40af">Net Margin (USD)</span>
          <span style="font-weight:800;font-size:18px;color:#1e40af">${fmtMajor(mUSD.paylode_net,'USD')}</span>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">Recent Transactions</div>
          <button class="btn btn-outline btn-sm" onclick="navigate('transactions')">View All</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Reference</th><th>Amount</th><th>Channel</th><th>Status</th></tr></thead>
            <tbody>
              ${rows.length ? rows.map(t => `<tr ${t.currency==='USD'?'style="background:#f8fbff"':''}>
                <td class="mono" style="font-size:11px">${t.reference}</td>
                <td style="white-space:nowrap">${txnAmt(t)} ${t.currency==='USD'?ccyChip('USD'):''}</td>
                <td><span class="tag">${t.channel}${t.currency==='USD'?' · Intl':''}</span></td>
                <td>${statusBadge(t.status)}</td>
              </tr>`).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:20px">No transactions yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${d.kyc_pending > 0 ? `<div class="section-gap"><div class="warn-box">⚠ ${d.kyc_pending} KYC application${d.kyc_pending>1?'s':''} pending review — <a href="#" onclick="navigate('compliance')">Review now →</a></div></div>` : ''}`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load dashboard: ' + e.message);
  }
}

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
// Payouts are a transaction type too — surfaced alongside payments via a toggle.
async function loadPayoutsLedger(page=1, filters={}) {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    let url = `/payouts/logs?page=${page}&perPage=20`;
    if (filters.status) url += `&status=${filters.status}`;
    const res = await apiFetch(url);
    if (!res?.data) { el.innerHTML = errorBox('Could not load payouts'); return; }
    const items = res.data.data || [];
    const meta  = res.data.meta || { page:1, pages:1, total:0 };
    const backPage = currentRole === 'merchant' ? 'merch_overview' : currentRole === 'aggregator' ? 'agg_overview' : 'overview';
    el.innerHTML = `
    <div class="page-header flex-between">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-outline btn-sm" onclick="goBack()" style="font-size:12px">&#8592; Back</button>
        <div>
          <div class="page-title">All Transactions</div>
          <div class="page-desc">${fmtNum(meta.total)} payout item(s)</div>
          <div style="margin-top:6px">
            <button class="btn btn-outline btn-sm" onclick="loadTransactions(1)">Payments</button>
            <button class="btn btn-primary btn-sm">Payouts</button>
          </div>
        </div>
      </div>
      <select class="form-input form-select" style="width:140px" onchange="loadPayoutsLedger(1,{status:this.value})">
        <option value="">All Status</option>
        <option value="success"${filters.status==='success'?' selected':''}>Success</option>
        <option value="failed"${filters.status==='failed'?' selected':''}>Failed</option>
        <option value="processing"${filters.status==='processing'?' selected':''}>Processing</option>
        <option value="scheduled"${filters.status==='scheduled'?' selected':''}>Scheduled</option>
      </select>
    </div>
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Batch Ref</th><th>Merchant</th><th>Recipient</th><th>Amount</th><th>Fee</th><th>Status</th><th>Reason / Note</th><th>Date</th></tr></thead>
      <tbody>
        ${items.length ? items.map(i => `<tr>
          <td class="mono" style="font-size:11px">${i.batch_ref||'—'}</td>
          <td>${i.business_name||'—'}</td>
          <td style="font-size:12px">${i.account_number||''} ${i.bank_code?('· '+i.bank_code):''}</td>
          <td style="font-weight:600;white-space:nowrap">&#8358;${Number(i.amount_naira||0).toLocaleString()}</td>
          <td class="mono" style="font-size:12px">&#8358;${Number(i.fee_naira||0).toLocaleString()}</td>
          <td><span class="tag">PAYOUT</span> ${statusBadge(i.status)}</td>
          <td style="font-size:12px;color:var(--gray-500)">${i.failure_reason||i.narration||'—'}</td>
          <td style="font-size:12px;color:var(--gray-400)">${i.created_at?new Date(i.created_at).toLocaleDateString('en-NG'):'—'}</td>
        </tr>`).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:20px">No payouts found</td></tr>'}
      </tbody>
    </table></div>
    <div class="flex-between" style="margin-top:16px">
      <div style="font-size:12px;color:var(--gray-500)">Page ${meta.page} of ${meta.pages}</div>
      <div class="flex">
        ${meta.page>1?`<button class="btn btn-outline btn-sm" onclick="loadPayoutsLedger(${meta.page-1})">← Previous</button>`:''}
        ${meta.page<meta.pages?`<button class="btn btn-outline btn-sm" onclick="loadPayoutsLedger(${meta.page+1})">Next →</button>`:''}
      </div>
    </div></div>`;
  } catch(e) { el.innerHTML = errorBox('Failed to load payouts: ' + e.message); }
}

async function loadTransactions(page=1, filters={}) {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    let url = `/transactions?page=${page}&perPage=20`;
    if (filters.status)   url += `&status=${filters.status}`;
    if (filters.channel)  url += `&channel=${filters.channel}`;
    if (filters.currency) url += `&currency=${filters.currency}`;
    if (filters.from)     url += `&from=${filters.from}`;
    if (filters.to)       url += `&to=${filters.to}`;

    const res = await apiFetch(url);
    if (!res?.data) { el.innerHTML = errorBox('Could not load transactions'); return; }

    const { data: txns, meta } = res.data;
    const backPage = currentRole === 'merchant' ? 'merch_overview' : currentRole === 'aggregator' ? 'agg_overview' : 'overview';

    el.innerHTML = `
    <div class="page-header flex-between">
      <div style="display:flex;align-items:center;gap:12px">
        <button class="btn btn-outline btn-sm" onclick="goBack()" style="font-size:12px">&#8592; Back</button>
        <div>
          <div class="page-title">All Transactions</div>
          <div class="page-desc">${fmtNum(meta.total)} total transactions</div>
          <div style="margin-top:6px">
            <button class="btn btn-primary btn-sm">Payments</button>
            <button class="btn btn-outline btn-sm" onclick="loadPayoutsLedger(1)">Payouts</button>
          </div>
        </div>
      </div>
      <div class="flex">
        <select class="form-input form-select" style="width:130px;margin-right:8px" onchange="loadTransactions(1,{status:this.value})">
          <option value="">All Status</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
          <option value="PENDING">Pending</option>
          <option value="REVERSED">Reversed</option>
        </select>
        <select class="form-input form-select" style="width:140px;margin-right:8px" onchange="loadTransactions(1,{channel:this.value})">
          <option value="">All Channels</option>
          <option value="CARD">Card</option>
          <option value="BANK_TRANSFER">Bank Transfer</option>
          <option value="USSD">USSD</option>
        </select>
        <select class="form-input form-select" style="width:150px;margin-right:8px" onchange="loadTransactions(1,{currency:this.value})">
          <option value="">All Currencies</option>
          <option value="NGN"${filters.currency==='NGN'?' selected':''}>₦ Local (NGN)</option>
          <option value="USD"${filters.currency==='USD'?' selected':''}>$ International (USD)</option>
        </select>
        <button class="btn btn-outline btn-sm" onclick="exportTransactionsCsv()">&#8681; Export CSV</button>
        <button class="btn btn-outline btn-sm" onclick="emailTransactionsCsv()">&#9993; Email to me</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Fee</th><th>Settled</th><th>Channel</th><th>Currency</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${txns.length ? txns.map(t => `<tr ${t.currency==='USD'?'style="background:#f8fbff"':''}>
              <td class="mono" style="font-size:11px">${t.reference}</td>
              <td>${t.merchant?.businessName||'—'}</td>
              <td style="font-weight:600;white-space:nowrap" title="Gross collected">${fmtMoney(t.amount, t.currency)}</td>
              <td class="mono" style="font-size:12px">${fmtMoney(t.fees?.merchant_fee||0, t.currency)}</td>
              <td class="mono text-lime" style="font-size:12px;font-weight:600" title="Amount the merchant receives">${fmtMoney(t.settlement_amount != null ? t.settlement_amount : (Number(t.amount) - (t.fees?.merchant_fee||0)), t.currency)}</td>
              <td><span class="tag">${t.channel}${t.currency==='USD'?' · Intl':''}</span></td>
              <td>${ccyChip(t.currency)}</td>
              <td>${statusBadge(t.status)}</td>
              <td style="font-size:12px;color:var(--gray-400)">${new Date(t.created_at).toLocaleDateString('en-NG')}</td>
            </tr>`).join('') : '<tr><td colspan="9" style="text-align:center;color:var(--gray-400);padding:20px">No transactions found</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="flex-between" style="margin-top:16px">
        <div style="font-size:12px;color:var(--gray-500)">Page ${meta.page} of ${meta.pages}</div>
        <div class="flex">
          ${meta.page > 1 ? `<button class="btn btn-outline btn-sm" onclick="loadTransactions(${meta.page-1})">← Previous</button>` : ''}
          ${meta.page < meta.pages ? `<button class="btn btn-outline btn-sm" onclick="loadTransactions(${meta.page+1})">Next →</button>` : ''}
        </div>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load transactions: ' + e.message);
  }
}

// ── Generic report helpers — download OR email any client-built report ───────
function _utf8ToBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function _downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: (mime||'text/plain') + ';charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}
// Email a report to the logged-in user (staff may pass a recipient).
async function emailReportFile(filename, base64, mime, to) {
  const res = await apiFetch('/reports/email', { method:'POST', body: JSON.stringify({ filename, content_base64: base64, mime, to }) });
  if (res && res.status) alert(res.message || 'Report emailed to you.');
  else alert((res && res.message) || 'Could not email the report.');
}
// Email a SheetJS workbook (xlsx) to the logged-in user.
async function _emailXlsx(wb, filename) {
  var b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  await emailReportFile(filename, b64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

async function _buildTransactionsCsv() {
  const res = await apiFetch('/transactions?page=1&perPage=1000');
  const txns = res?.data?.data || [];
  const headers = ['Reference','Merchant','Currency','Amount','Fee','Channel','International','Status','Date'];
  const rows = txns.map(t => [
    t.reference, (t.merchant?.businessName||'').replace(/,/g,' '), t.currency || 'NGN',
    (Number(t.amount)/100).toFixed(2), (Number(t.fees?.merchant_fee||0)/100).toFixed(2),
    t.channel, t.currency === 'USD' ? 'YES' : 'NO', t.status,
    new Date(t.created_at).toLocaleDateString('en-NG'),
  ]);
  const csv = '﻿' + [headers, ...rows].map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',')).join('\n');
  return { csv, filename: 'paylode-transactions-' + new Date().toISOString().split('T')[0] + '.csv' };
}
async function exportTransactionsCsv() {
  try { const { csv, filename } = await _buildTransactionsCsv(); _downloadText(csv, filename, 'text/csv'); }
  catch(e) { alert('Export failed: ' + e.message); }
}
async function emailTransactionsCsv() {
  try { const { csv, filename } = await _buildTransactionsCsv(); await emailReportFile(filename, _utf8ToBase64(csv), 'text/csv'); }
  catch(e) { alert('Email failed: ' + e.message); }
}

// ── MERCHANTS ─────────────────────────────────────────────────────────────────
async function loadMerchants(page=1) {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const res = await apiFetch(`/merchants?page=${page}&perPage=20`);
    if (!res?.data) { el.innerHTML = errorBox('Could not load merchants'); return; }

    const { data: merchants, meta } = res.data;

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Merchants</div><div class="page-desc">${fmtNum(meta.total)} total merchants</div></div>
      <div style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" onclick="copyAdminSignupLink()">Copy Sign-Up Link</button><button class="btn btn-primary" onclick="navigate('admin_onboard')">+ Onboard Merchant</button></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Code</th><th>Business Name</th><th>Category</th><th>Aggregator</th><th>KYC Tier</th><th>Rate</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${merchants.length ? merchants.map(m => `<tr>
              <td class="mono" style="font-size:11px">${m.merchantCode}</td>
              <td style="font-weight:500">${m.businessName}</td>
              <td>${m.category}</td>
              <td>${m.aggregator?.companyName||'Direct'}</td>
              <td>${m.kycTier ? `Tier ${m.kycTier}` : '—'}</td>
              <td class="mono">${m.processingRate ? (Number(m.processingRate)*100).toFixed(1)+'%' : '—'}</td>
              <td>${statusBadge(m.kycStatus)}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="viewMerchant('${m.id}')">View</button>&nbsp;
                ${m.isActive
                  ? `<button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="suspendMerchant('${m.id}','${m.businessName}')">Suspend</button>`
                  : `<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="activateMerchant('${m.id}','${m.businessName}')">Activate</button>`}
                ${userHasPerm('edit_merchants') ? `&nbsp;<button class="btn btn-lime btn-sm" onclick="editMerchant('${m.id}')">&#9998; Edit</button>` : ''}
              </td>
            </tr>`).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--gray-400);padding:20px">No merchants yet</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="flex-between" style="margin-top:16px">
        <div style="font-size:12px;color:var(--gray-500)">Page ${meta?.page||1} of ${meta?.pages||1}</div>
        <div class="flex">
          ${(meta?.page||1) > 1 ? `<button class="btn btn-outline btn-sm" onclick="loadMerchants(${meta.page-1})">← Previous</button>` : ''}
          ${(meta?.page||1) < (meta?.pages||1) ? `<button class="btn btn-outline btn-sm" onclick="loadMerchants(${meta.page+1})">Next →</button>` : ''}
        </div>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load merchants: ' + e.message);
  }
}

// ── MERCHANT DETAIL VIEW ──────────────────────────────────────────────────────
async function viewMerchant(id) {
  var res = await apiFetch('/merchants/' + id);
  if (!res || !res.data) { alert('Could not load merchant details'); return; }
  var m = res.data;
  var rate = m.processingRate ? (Number(m.processingRate) * 100).toFixed(1) + '%' : '—';
  var isSA = (currentRole === 'superadmin');
  var canReview = (['superadmin','admin','compliance'].indexOf(currentRole) !== -1); // suspend/activate/docs
  var canManage = (currentRole === 'superadmin' || currentRole === 'admin');         // edit/close
  var canViewApp = (currentRole === 'superadmin' || currentRole === 'compliance');    // see the submitted onboarding form
  var nameEsc = (m.businessName||'').replace(/'/g,'');

  var overviewHtml =
    '<div class="rev-row"><span class="rev-label">Merchant Code</span><span class="rev-value mono" style="font-size:12px">' + (m.merchantCode || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Category</span><span class="rev-value">' + (m.category || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">KYC Status</span><span class="rev-value">' + statusBadge(m.kycStatus) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">KYC Tier</span><span class="rev-value">' + (m.kycTier ? 'Tier ' + m.kycTier : '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Compliance / PEP</span><span class="rev-value">' + _mComplianceBadge(m) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Card Scope</span><span class="rev-value">' + (m.cardAcceptanceScope === 'international' ? '<span class="badge badge-blue">International (USD/Mastercard)</span>' : '<span class="badge badge-gray">Domestic (Naira)</span>') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Default Rate</span><span class="rev-value">' + rate + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Email</span><span class="rev-value" style="font-size:12px">' + (m.user && m.user.email ? m.user.email : (m.businessEmail || '—')) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Phone</span><span class="rev-value">' + (m.phone || (m.user && m.user.phone) || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Address</span><span class="rev-value" style="font-size:12px">' + (m.address || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Aggregator</span><span class="rev-value">' + (m.aggregator && m.aggregator.companyName ? m.aggregator.companyName : 'Direct') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">RC Number</span><span class="rev-value mono">' + (m.rcNumber || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Settlement Bank</span><span class="rev-value">' + (m.settlementBank || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Settlement Account</span><span class="rev-value mono">' + (m.settlementAccount || '—') + '</span></div>' +
    (function() {
      var vst = m.settleVerifyStatus || 'unverified';
      var vstColors = { unverified:'badge-gray', pending_manual:'badge-amber', auto_verified:'badge-green', manual_approved:'badge-green', rejected:'badge-red' };
      var vstLabels = { unverified:'Not Submitted', pending_manual:'Awaiting Review', auto_verified:'Auto Verified', manual_approved:'Approved', rejected:'Rejected' };
      return '<div class="rev-row"><span class="rev-label">Bank Verification</span><span class="rev-value"><span class="badge ' + (vstColors[vst]||'badge-gray') + '">' + (vstLabels[vst]||vst) + '</span></span></div>';
    })() +
    '<div class="rev-row"><span class="rev-label">Joined</span><span class="rev-value">' + (m.createdAt ? new Date(m.createdAt).toLocaleDateString('en-NG') : '—') + '</span></div>' +
    '<div class="divider"></div>' +
    '<div class="flex-between">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Close</button>' +
      '<div class="flex" style="gap:8px;flex-wrap:wrap;justify-content:flex-end">' +
        (canReview ? '<button class="btn btn-outline" onclick="openDocsModal(\'merchant\',\'' + id + '\',\'' + nameEsc + '\')">&#128196; KYC Documents</button>' : '') +
        (canViewApp ? '<button class="btn btn-outline" onclick="loadMerchantApplication(\'' + id + '\')">&#128203; Application Form</button>' : '') +
        (canReview ? '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\';resendSandbox(\'' + id + '\',\'' + nameEsc + '\')">&#128231; Resend Sandbox</button>' : '') +
        (canReview ? (m.isActive
          ? '<button class="btn btn-outline" style="color:var(--red);border-color:var(--red)" onclick="document.getElementById(\'modal\').style.display=\'none\';suspendMerchant(\'' + id + '\',\'' + nameEsc + '\')">Suspend</button>'
          : '<button class="btn btn-outline" style="color:var(--green);border-color:var(--green)" onclick="document.getElementById(\'modal\').style.display=\'none\';activateMerchant(\'' + id + '\',\'' + nameEsc + '\')">Activate</button>') : '') +
        (canManage ? '<button class="btn btn-outline" style="color:var(--red);border-color:var(--red)" onclick="document.getElementById(\'modal\').style.display=\'none\';closeMerchant(\'' + id + '\',\'' + nameEsc + '\')">Close Account</button>' : '') +
        (isSA ? '<button class="btn btn-outline" style="color:#fff;background:var(--red);border-color:var(--red)" onclick="document.getElementById(\'modal\').style.display=\'none\';deleteMerchant(\'' + id + '\',\'' + nameEsc + '\')">&#128465; Delete</button>' : '') +
        (canManage ? '<button class="btn btn-lime" onclick="document.getElementById(\'modal\').style.display=\'none\';editMerchant(\'' + id + '\')">&#9998; Edit</button>' : '') +
      '</div>' +
    '</div>';

  var tabs = [{ id:'overview', label:'Overview' }, { id:'rates', label:'Rate Config' }, { id:'outlets', label:'Outlets' }];
  var tabNav = '<div class="tab-nav">' + tabs.map(function(t) {
    return '<button class="tab-btn' + (t.id === 'overview' ? ' active' : '') + '" onclick="switchMerchantTab(\'' + t.id + '\',\'' + id + '\')">' + t.label + '</button>';
  }).join('') + '</div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">' + (m.businessName || 'Merchant') + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    tabNav +
    '<div id="merchant-tab-content">' + overviewHtml + '</div>';

  document.getElementById('modal').style.display = 'flex';
}

function switchMerchantTab(tab, merchantId) {
  document.querySelectorAll('#modal-inner .tab-btn').forEach(function(b) {
    b.classList.toggle('active', b.textContent.toLowerCase().replace(' ','') === tab || b.textContent.toLowerCase() === tab);
  });
  if (tab === 'overview')  viewMerchant(merchantId);
  if (tab === 'rates')     loadMerchantRates(merchantId);
  if (tab === 'outlets')   loadMerchantOutlets(merchantId);
}

// ── MERCHANT APPLICATION FORM (SA / Compliance) ───────────────────────────────
// Shows the full onboarding form the merchant filled in, and lets the reviewer
// download/print it for their records. Data = onboarding_submissions.data (jsonb).
function _appEsc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function _appHumanize(k) { return String(k).replace(/_/g,' ').replace(/\b\w/g, function(c){ return c.toUpperCase(); }); }
function _appSectionTitle(k) {
  var M = { np_identity:'Personal / Identity', np_contact:'Contact Details', np_business:'Business Details',
            entity_details:'Entity / Registration', settlement:'Settlement Account', dd_questions:'Due Diligence',
            ynAnswers:'Due Diligence Answers', business:'Business Details' };
  return M[k] || _appHumanize(k);
}
function _appFmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map(_appFmt).join(', ') : '—';
  if (typeof v === 'object') return Object.keys(v).map(function(k){ return _appHumanize(k) + ': ' + _appFmt(v[k]); }).join('; ');
  var s = String(v);
  if (s.indexOf('data:') === 0) return '[embedded file]';   // don't dump base64 blobs
  if (s.length > 300) return s.slice(0, 300) + '…';
  return s;
}
// data keys rendered via dedicated top-level fields (skip in the generic loop).
var _APP_SKIP_KEYS = { signature: 1, principals: 1 };
function _appRows(obj) {
  var keys = Object.keys(obj || {});
  if (!keys.length) return '<div class="rev-row"><span class="rev-value">—</span></div>';
  return keys.map(function(k) {
    return '<div class="rev-row"><span class="rev-label">' + _appEsc(_appHumanize(k)) +
           '</span><span class="rev-value" style="font-size:12px">' + _appEsc(_appFmt(obj[k])) + '</span></div>';
  }).join('');
}
// Builds the inner HTML shared by the on-screen view and the print/download doc.
function buildMerchantApplicationInner(app) {
  var data = app.data || {};
  var head =
    '<div class="rev-row"><span class="rev-label">Business Name</span><span class="rev-value">' + _appEsc(app.businessName || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Reference</span><span class="rev-value mono" style="font-size:12px">' + _appEsc(app.reference || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Applicant Type</span><span class="rev-value">' + _appEsc(app.applicantType || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Form Type</span><span class="rev-value">' + _appEsc(app.formType || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Submitted</span><span class="rev-value">' + (app.submittedAt ? new Date(app.submittedAt).toLocaleString('en-NG') : '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Status</span><span class="rev-value">' + _appEsc(app.status || '—') + '</span></div>';
  var sections = Object.keys(data).filter(function(k){ return !_APP_SKIP_KEYS[k]; }).map(function(k) {
    var v = data[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return '<h4 class="app-sec">' + _appEsc(_appSectionTitle(k)) + '</h4>' + _appRows(v);
    }
    return '<div class="rev-row"><span class="rev-label">' + _appEsc(_appHumanize(k)) + '</span><span class="rev-value">' + _appEsc(_appFmt(v)) + '</span></div>';
  }).join('');
  var principals = (app.principals || []).map(function(p, i) {
    return '<h4 class="app-sec">Principal ' + (i + 1) + '</h4>' + _appRows(p);
  }).join('');
  var docs = (app.documents || []).length
    ? '<h4 class="app-sec">Uploaded Documents</h4>' + (app.documents || []).map(function(d) {
        return '<div class="rev-row"><span class="rev-label">' + _appEsc(d.docType || d.key || 'Document') + '</span><span class="rev-value" style="font-size:12px">' + _appEsc(d.name || '—') + (d.path ? '' : ' (not uploaded)') + '</span></div>';
      }).join('')
    : '';
  var sigSrc = app.signature ? (typeof app.signature === 'string' ? app.signature : (app.signature.dataUrl || '')) : '';
  var sig = sigSrc ? '<h4 class="app-sec">Signature</h4><img src="' + sigSrc + '" alt="signature" style="max-width:240px;border:1px solid #e2e8f0;border-radius:6px">' : '';
  return '<h4 class="app-sec">Application Summary</h4>' + head + sections + principals + docs + sig;
}

async function loadMerchantApplication(id) {
  var host = document.getElementById('modal-inner');
  var tabNav = '<div class="tab-nav"><button class="tab-btn" onclick="viewMerchant(\'' + id + '\')">Overview</button>' +
    '<button class="tab-btn" onclick="loadMerchantRates(\'' + id + '\')">Rate Config</button>' +
    '<button class="tab-btn" onclick="loadMerchantOutlets(\'' + id + '\')">Outlets</button>' +
    '<button class="tab-btn active">Application Form</button></div>';
  host.innerHTML = '<div class="modal-header"><div class="modal-title">Application Form</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    tabNav + '<div style="padding:16px;color:var(--gray-400)">Loading application…</div>';
  var res = await apiFetch('/onboarding/merchant/' + id + '/application');
  if (!res || !res.status || !res.data) {
    host.innerHTML = '<div class="modal-header"><div class="modal-title">Application Form</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
      tabNav + '<div style="padding:20px;color:var(--gray-400)">No onboarding application form on file for this merchant.<br><span style="font-size:12px">The account may have been created manually or predates the online onboarding form.</span></div>';
    return;
  }
  window._lastApplication = res.data;
  host.innerHTML = '<div class="modal-header"><div class="modal-title">Application Form</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    tabNav +
    '<div id="application-body">' + buildMerchantApplicationInner(res.data) + '</div>' +
    '<div class="divider"></div><div class="flex-between">' +
      '<button class="btn btn-outline" onclick="viewMerchant(\'' + id + '\')">&#8592; Back</button>' +
      '<button class="btn btn-lime" onclick="downloadMerchantApplication(\'' + id + '\')">&#128229; Download / Print Form</button>' +
    '</div>';
}

async function downloadMerchantApplication(id) {
  var app = window._lastApplication;
  if (!app || app.merchantId !== id) {
    var res = await apiFetch('/onboarding/merchant/' + id + '/application');
    app = res && res.data;
  }
  if (!app) { alert('No application on file to download.'); return; }
  var css =
    'body{font-family:Arial,Helvetica,sans-serif;color:#1a2744;max-width:820px;margin:0 auto;padding:28px 22px}' +
    'h1{font-size:20px;margin:0 0 2px}.meta{color:#64748b;font-size:12px;margin-bottom:18px}' +
    'h4.app-sec{margin:20px 0 6px;font-size:13px;color:#1a2744;border-bottom:2px solid #7DC534;padding-bottom:4px}' +
    '.rev-row{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid #eef2f7;font-size:12.5px}' +
    '.rev-label{color:#64748b;flex:0 0 42%}.rev-value{text-align:right;flex:1;word-break:break-word}.mono{font-family:monospace}' +
    '.topbar{border-bottom:3px solid #1a2744;padding-bottom:10px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-end}' +
    '.brand{font-weight:800;color:#1a2744;font-size:16px}.brand span{color:#7DC534}' +
    '@media print{.noprint{display:none}}' +
    '.noprint{margin-top:22px;text-align:center}.pbtn{background:#7DC534;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer}';
  var when = new Date().toLocaleString('en-NG');
  var doc =
    '<!doctype html><html><head><meta charset="utf-8"><title>' + _appEsc(app.businessName || 'Merchant') + ' — Onboarding Application</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div class="topbar"><div class="brand">Paylode</div><div class="meta" style="text-align:right">Merchant Onboarding Application<br>Generated ' + _appEsc(when) + '</div></div>' +
    '<h1>' + _appEsc(app.businessName || 'Merchant') + '</h1>' +
    '<div class="meta">Reference ' + _appEsc(app.reference || '—') + ' &middot; Submitted ' + (app.submittedAt ? new Date(app.submittedAt).toLocaleString('en-NG') : '—') + '</div>' +
    buildMerchantApplicationInner(app) +
    '<div class="noprint"><button class="pbtn" onclick="window.print()">Print / Save as PDF</button></div>' +
    '</body></html>';
  var w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups to download the application form.'); return; }
  w.document.open(); w.document.write(doc); w.document.close();
  w.focus();
  setTimeout(function(){ try { w.print(); } catch (e) {} }, 400);
}

// ── MERCHANT RATE CONFIG ──────────────────────────────────────────────────────

async function loadMerchantRates(id) {
  var isSA = (currentRole === 'superadmin');
  var res = await apiFetch('/merchants/' + id + '/rates');
  var rates = (res && Array.isArray(res.data)) ? res.data : [];
  var channels = ['CARD','BANK_TRANSFER','USSD','DIRECT_DEBIT','ALL'];

  function fmtKobo(k) { return k > 0 ? '&#8358;' + (k/100).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0}) : '—'; }
  var rows = rates.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No overrides set — platform defaults apply</td></tr>'
    : rates.map(function(r) {
        return '<tr>' +
          '<td><span class="badge badge-gray">' + r.channel + '</span></td>' +
          '<td class="mono">' + (Number(r.rate)*100).toFixed(2) + '%</td>' +
          '<td class="mono">' + fmtKobo(r.flat_fee) + '</td>' +
          '<td class="mono">' + fmtKobo(r.min_charge || 0) + '</td>' +
          '<td class="mono">' + (r.cap > 0 ? '&#8358;' + (r.cap/100).toLocaleString() + ' cap' : 'No cap') + '</td>' +
          '<td style="font-size:11px;color:var(--gray-400)">' + (r.notes||'—') + '</td>' +
          '<td>' + (isSA ? '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deleteMerchantRate(\'' + id + '\',\'' + r.channel + '\')">Remove</button>' : '') + '</td>' +
        '</tr>';
      }).join('');

  var addForm = isSA
    ? '<div class="divider"></div>' +
      '<div style="font-weight:600;margin-bottom:10px;font-size:13px">Set / Update Rate Override</div>' +
      '<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">' +
        '<div><label class="form-label">Channel</label>' +
          '<select class="form-input form-select" id="rc-channel">' + channels.map(function(c){return '<option>'+c+'</option>';}).join('') + '</select></div>' +
        '<div><label class="form-label">Rate (%)</label>' +
          '<input class="form-input" type="number" id="rc-rate" value="1.5" step="0.01" min="0" max="20" placeholder="e.g. 1.5"></div>' +
        '<div><label class="form-label">Flat Fee (&#8358;, 0=none)</label>' +
          '<input class="form-input" type="number" id="rc-flat" value="0" step="10" min="0" placeholder="e.g. 50"></div>' +
      '</div>' +
      '<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">' +
        '<div><label class="form-label">Min Charge (&#8358;, 0=none)</label>' +
          '<input class="form-input" type="number" id="rc-min" value="0" step="10" min="0" placeholder="e.g. 20"></div>' +
        '<div><label class="form-label">Max Charge (&#8358;, 0=none)</label>' +
          '<input class="form-input" type="number" id="rc-cap" value="0" step="100" min="0" placeholder="e.g. 2000"></div>' +
        '<div><label class="form-label">Notes</label>' +
          '<input class="form-input" type="text" id="rc-notes" placeholder="Optional audit note"></div>' +
      '</div>' +
      '<div class="info-box" style="font-size:12px;margin-bottom:12px">Fee = (Rate% × Amount) + Flat Fee, clamped to [Min, Max]. Set 0 for unconstrained.</div>' +
      '<button class="btn btn-lime" onclick="saveMerchantRate(\'' + id + '\')">Save Rate Override</button>'
    : '';

  var tabNav = '<div class="tab-nav"><button class="tab-btn" onclick="viewMerchant(\'' + id + '\')">Overview</button><button class="tab-btn active">Rate Config</button><button class="tab-btn" onclick="loadMerchantOutlets(\'' + id + '\')">Outlets</button></div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Rate Config</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    tabNav +
    '<div class="table-wrap"><table style="width:100%;margin-bottom:0"><thead><tr>' +
    '<th>Channel</th><th>Rate %</th><th>Flat Fee</th><th>Min Charge</th><th>Max Charge</th><th>Notes</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' + addForm;

  document.getElementById('modal').style.display = 'flex';
}

async function saveMerchantRate(id) {
  var channel   = document.getElementById('rc-channel').value;
  var rateVal   = parseFloat(document.getElementById('rc-rate').value) / 100;
  var flatNaira = parseFloat(document.getElementById('rc-flat').value) || 0;
  var minNaira  = parseFloat(document.getElementById('rc-min').value)  || 0;
  var capNaira  = parseFloat(document.getElementById('rc-cap').value)  || 0;
  var notes     = document.getElementById('rc-notes').value;
  if (isNaN(rateVal)) { alert('Enter a valid rate'); return; }
  var res = await apiFetch('/merchants/' + id + '/rates', {
    method: 'POST',
    body: JSON.stringify({
      channel,
      rate:       rateVal,
      flat_fee:   Math.round(flatNaira * 100),
      min_charge: Math.round(minNaira  * 100),
      cap:        Math.round(capNaira  * 100),
      notes,
    }),
  });
  if (res && res.status) loadMerchantRates(id);
  else alert('Error: ' + ((res && res.message) || 'Save failed'));
}

async function deleteMerchantRate(id, channel) {
  if (!confirm('Remove ' + channel + ' rate override for this merchant? They will fall back to platform defaults.')) return;
  var res = await apiFetch('/merchants/' + id + '/rates/' + channel, { method: 'DELETE' });
  if (res && res.status) loadMerchantRates(id);
  else alert('Error: ' + ((res && res.message) || 'Delete failed'));
}

// ── MERCHANT OUTLETS ──────────────────────────────────────────────────────────

async function loadMerchantOutlets(id) {
  var isSA = (currentRole === 'superadmin');
  var res = await apiFetch('/merchants/' + id + '/outlets');
  var outlets = (res && Array.isArray(res.data)) ? res.data : [];

  var rows = outlets.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:20px">No outlets yet</td></tr>'
    : outlets.map(function(o) {
        return '<tr>' +
          '<td><strong>' + (o.outletName || o.businessName) + '</strong><br><span style="font-size:11px;color:var(--gray-400)">' + o.merchantCode + '</span></td>' +
          '<td style="font-size:12px">' + (o.businessEmail || '—') + '</td>' +
          '<td>' + statusBadge(o.kycStatus) + '</td>' +
          '<td>' + (isSA ? '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deactivateOutlet(\'' + id + '\',\'' + o.id + '\',\'' + (o.outletName||o.businessName).replace(/'/g,'') + '\')">Deactivate</button>' : '') + '</td>' +
        '</tr>';
      }).join('');

  var addForm = isSA ? `
    <div class="divider"></div>
    <div style="font-weight:600;margin-bottom:10px;font-size:13px">Add New Outlet</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div><label class="form-label">Outlet Name / Branch</label><input class="form-input" id="out-name" placeholder="e.g. Ikeja Branch"></div>
      <div><label class="form-label">Business Name</label><input class="form-input" id="out-bname" placeholder="Full legal name"></div>
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div><label class="form-label">Email</label><input class="form-input" type="email" id="out-email" placeholder="outlet@business.com"></div>
      <div><label class="form-label">Phone</label><input class="form-input" id="out-phone" placeholder="08012345678"></div>
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div><label class="form-label">State</label><input class="form-input" id="out-state" placeholder="Lagos"></div>
      <div><label class="form-label">Address</label><input class="form-input" id="out-address" placeholder="Full address"></div>
    </div>
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:12px;margin-bottom:12px">
      Outlet inherits parent's settlement account and aggregator. KYC covered under parent. A temporary login will be returned — share it with the outlet manager.
    </div>
    <button class="btn btn-lime" onclick="createOutlet('${id}')">Create Outlet</button>
  ` : '';

  var tabNav = '<div class="tab-nav"><button class="tab-btn" onclick="viewMerchant(\'' + id + '\')">Overview</button><button class="tab-btn" onclick="loadMerchantRates(\'' + id + '\')">Rate Config</button><button class="tab-btn active">Outlets</button></div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Outlets (' + outlets.length + ')</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    tabNav +
    '<table class="data-table" style="width:100%;margin-bottom:0"><thead><tr>' +
    '<th>Outlet</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>' +
    rows + '</tbody></table>' + addForm;

  document.getElementById('modal').style.display = 'flex';
}

async function createOutlet(parentId) {
  var payload = {
    outlet_name:    (document.getElementById('out-name').value || '').trim(),
    business_name:  (document.getElementById('out-bname').value || '').trim(),
    business_email: (document.getElementById('out-email').value || '').trim(),
    business_phone: (document.getElementById('out-phone').value || '').trim(),
    state:          (document.getElementById('out-state').value || '').trim(),
    address:        (document.getElementById('out-address').value || '').trim(),
  };
  if (!payload.outlet_name || !payload.business_name || !payload.business_email || !payload.business_phone || !payload.state) {
    alert('Please fill all required fields'); return;
  }
  var res = await apiFetch('/merchants/' + parentId + '/outlets', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (res && res.status && res.data) {
    alert('Outlet created!\n\nMerchant Code: ' + res.data.merchantCode + '\nTemp Password: ' + res.data.temp_password + '\n\nSave this password — it won\'t be shown again.');
    loadMerchantOutlets(parentId);
  } else {
    alert('Error: ' + ((res && res.message) || 'Create failed'));
  }
}

async function deactivateOutlet(parentId, outletId, name) {
  if (!confirm('Deactivate outlet "' + name + '"? This suspends their access without deleting transaction history.')) return;
  var res = await apiFetch('/merchants/' + parentId + '/outlets/' + outletId, { method: 'DELETE' });
  if (res && res.status) loadMerchantOutlets(parentId);
  else alert('Error: ' + ((res && res.message) || 'Deactivate failed'));
}

async function suspendMerchant(id, name) {
  var reason = prompt('Reason for suspending ' + name + ' (shown in audit log):');
  if (reason === null) return; // cancelled
  var res = await apiFetch('/merchants/' + id + '/suspend', {
    method: 'PUT',
    body:   JSON.stringify({ reason: reason }),
  });
  if (res && res.status) {
    alert(name + ' has been suspended.');
    loadMerchants();
  } else {
    alert('Error: ' + ((res && res.message) || 'Suspend failed'));
  }
}

async function activateMerchant(id, name) {
  if (!confirm('Reactivate ' + name + '? They will be able to process payments again.')) return;
  var res = await apiFetch('/merchants/' + id + '/activate', { method: 'PUT' });
  if (res && res.status) {
    alert(name + ' has been reactivated.');
    loadMerchants();
  } else {
    alert('Error: ' + ((res && res.message) || 'Activate failed'));
  }
}

async function closeMerchant(id, name) {
  if (!confirm('Close (off-board) ' + name + '? The account will be deactivated and can only be reopened by re-activation.')) return;
  var reason = prompt('Reason for closure (shown in audit log):');
  if (reason === null) return;
  var res = await apiFetch('/merchants/' + id + '/close', { method: 'PUT', body: JSON.stringify({ reason: reason }) });
  if (res && res.status) { alert(name + ' has been closed.'); loadMerchants(); }
  else alert('Error: ' + ((res && res.message) || 'Close failed'));
}

// SA/admin/compliance: (re)send sandbox credentials to an existing merchant.
// Resets the login to a fresh temp password and (re)issues any missing sk_test/pk_test keys.
async function resendSandbox(id, name) {
  if (!confirm('Email sandbox credentials to ' + name + '?\n\nThis resets their dashboard password to a new temporary one and (re)issues any missing sandbox keys.')) return;
  var res = await apiFetch('/merchants/' + id + '/resend-sandbox', { method: 'POST', body: JSON.stringify({}) });
  if (!res || !res.status) { alert('Error: ' + ((res && res.message) || 'Resend failed')); return; }
  var d = res.data || {};
  var msg = d.credentials_emailed ? ('Sandbox credentials emailed to ' + d.email + '.') : ('Email not sent (SMTP off / failed) — copy these and share securely:');
  if (d.temp_password) msg += '\n\nTemporary password: ' + d.temp_password;
  if (d.keys && d.keys.sk_test) msg += '\nsk_test: ' + d.keys.sk_test;
  if (d.keys && d.keys.pk_test) msg += '\npk_test: ' + d.keys.pk_test;
  if (d.keys && (d.keys.sk_test || d.keys.pk_test)) msg += '\n\n(API keys are shown ONCE.)';
  alert(msg);
}

// Permanently delete a merchant (SA only). Backend refuses if the account has any
// financial history → those must be Closed instead (the alert relays that reason).
async function deleteMerchant(id, name) {
  if (!confirm('PERMANENTLY DELETE ' + name + '?\n\nThis cannot be undone. Only empty/test accounts (no transactions, settlements or payouts) can be deleted — accounts with history must be Closed instead.')) return;
  if (!confirm('Final check: type-confirm by clicking OK to permanently delete ' + name + '.')) return;
  var reason = prompt('Reason for deletion (shown in audit log):') || '';
  var res = await apiFetch('/merchants/' + id, { method: 'DELETE', body: JSON.stringify({ reason: reason }) });
  if (res && res.status) { alert(name + ' has been permanently deleted.'); loadMerchants(); }
  else alert((res && res.message) || 'Delete failed'); // relays "use Close instead" for accounts with history
}

// Permanently delete an aggregator (SA only). Backend refuses if it still has
// linked merchants or payout history.
async function deleteAggregator(id, name) {
  if (!confirm('PERMANENTLY DELETE aggregator ' + name + '?\n\nThis cannot be undone. Only aggregators with no linked merchants and no payout history can be deleted.')) return;
  var reason = prompt('Reason for deletion (shown in audit log):') || '';
  var res = await apiFetch('/aggregators/' + id, { method: 'DELETE', body: JSON.stringify({ reason: reason }) });
  if (res && res.status) { alert(name + ' has been permanently deleted.'); loadAggregators(); }
  else alert((res && res.message) || 'Delete failed');
}

// Merchant detail action hub — alias used by the KYC Review register.
function openMerchantDetail(id) { return viewMerchant(id); }

// ── MERCHANT EDIT (role-aware) ────────────────────────────────────────────────
async function editMerchant(id) {
  if (!userHasPerm('edit_merchants')) { alert('You have view-only access to merchants.'); return; }
  var isSuperAdmin = (currentRole === 'superadmin');
  var results = await Promise.all([
    apiFetch('/merchants/' + id),
    isSuperAdmin ? apiFetch('/aggregators') : Promise.resolve(null),
    isSuperAdmin ? apiFetch('/merchants/' + id + '/rates') : Promise.resolve(null),
  ]);
  var mRes = results[0]; var aggRes = results[1];
  if (!mRes || !mRes.data) { alert('Could not load merchant'); return; }
  var m    = mRes.data;
  var aggs = (aggRes && aggRes.data) ? aggRes.data : [];
  var rateCfgs = (results[2] && results[2].data) ? results[2].data : [];
  var rateByCh = {}; rateCfgs.forEach(function(r) { rateByCh[r.channel] = r; });

  var cats = ['Retail','E-commerce','Transport','Education','Healthcare','Technology','Financial Services','Other'];
  var catOpts = cats.map(function(c) {
    return '<option value="' + c + '"' + (m.category === c ? ' selected' : '') + '>' + c + '</option>';
  }).join('');
  var currentEmail = (m.user && m.user.email) ? m.user.email : (m.businessEmail || '');
  var currentPhone = m.phone || (m.user && m.user.phone) || '';

  // Fields only super admin can edit
  var adminOnlyFields = '';
  if (isSuperAdmin) {
    var currentRate = m.processingRate ? (Number(m.processingRate) * 100).toFixed(1) : '1.5';
    var aggOpts = '<option value="">None (Direct)</option>' + aggs.map(function(a) {
      return '<option value="' + a.id + '"' + (m.aggregator && m.aggregator.id === a.id ? ' selected' : '') + '>' + (a.companyName || '') + '</option>';
    }).join('');
    var statuses = [['active','Active'],['suspended','Suspended'],['pending_kyc','Pending KYC'],['kyc_in_review','KYC In Review'],['kyc_rejected','KYC Rejected']];
    var statOpts = statuses.map(function(s) {
      return '<option value="' + s[0] + '"' + ((m.kycStatus || '').toLowerCase() === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
    }).join('');
    adminOnlyFields =
      '<div class="form-grid">' +
        '<div class="form-group"><label class="form-label">Processing Rate (%)</label>' +
          '<input class="form-input" type="number" id="em-rate" value="' + currentRate + '" step="0.1" min="0.1" max="5"></div>' +
        '<div class="form-group"><label class="form-label">Account Status</label>' +
          '<select class="form-input form-select" id="em-status">' + statOpts + '</select></div>' +
      '</div>' +
      '<div class="form-grid">' +
        '<div class="form-group"><label class="form-label">Settlement Bank</label>' +
          '<input class="form-input" id="em-bank" value="' + (m.settlementBank || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">Assign to Aggregator</label>' +
          '<select class="form-input form-select" id="em-agg">' + aggOpts + '</select></div>' +
      '</div>';
  }

  var modeLabel = isSuperAdmin ? 'Edit' : 'Edit Contact & Details';
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">' + modeLabel + ' — ' + (m.businessName || '') + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    (!isSuperAdmin ? '<div class="info-box" style="margin-bottom:16px;font-size:12px">You can update contact and business details. Rate and status changes require Paylode admin approval.</div>' : '') +
    '<div class="form-group"><label class="form-label">Business Name</label>' +
      '<input class="form-input" id="em-name" value="' + (m.businessName || '') + '"></div>' +
    '<div class="form-group"><label class="form-label">Category</label>' +
      '<select class="form-input form-select" id="em-cat">' + catOpts + '</select></div>' +
    '<div class="form-group"><label class="form-label">Email Address</label>' +
      '<input class="form-input" type="email" id="em-email" value="' + currentEmail + '"></div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Phone</label>' +
        '<input class="form-input" id="em-phone" value="' + currentPhone + '"></div>' +
      '<div class="form-group"><label class="form-label">RC Number</label>' +
        '<input class="form-input" id="em-rc" value="' + (m.rcNumber || '') + '"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Business Address</label>' +
      '<input class="form-input" id="em-address" value="' + (m.address || '') + '"></div>' +
    '<div style="border-top:1px solid var(--gray-100);margin:16px 0;padding-top:16px">' +
      '<div style="font-size:12px;font-weight:600;color:var(--gray-600);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Pricing &amp; Fees</div>' +
      '<div class="form-group"><label class="form-label">Fee Paid By</label>' +
        '<div class="flex" style="gap:12px;margin-top:4px">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">' +
            '<input type="radio" name="em-fee-payer" id="em-fp-customer" value="customer" ' + ((m.feePaidBy || m.fee_paid_by || 'customer') === 'customer' ? 'checked' : '') + '> Customer pays fee (default)</label>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">' +
            '<input type="radio" name="em-fee-payer" id="em-fp-merchant" value="merchant" ' + ((m.feePaidBy || m.fee_paid_by) === 'merchant' ? 'checked' : '') + '> Merchant pays fee</label>' +
        '</div>' +
        '<div class="form-hint">Customer pays: customer is debited principal + fee + VAT. Merchant pays: customer debited principal only, merchant settles net of fee.</div>' +
      '</div>' +
      (isSuperAdmin ? (function() {
        var channels = [['CARD_LOCAL','Local Cards'],['CARD_INTL','International Cards'],['VIRTUAL_ACCOUNT','Virtual Accounts'],['USSD','USSD'],['PAYOUT','Payouts']];
        return '<div style="font-size:12px;font-weight:500;color:var(--gray-600);margin:4px 0 6px">Per-product pricing — what we charge THIS merchant (overrides the platform default; leave a row blank to use the default)</div>' +
          '<div class="table-wrap"><table style="width:100%;font-size:12px"><thead><tr style="border-bottom:1px solid var(--gray-200)">' +
          '<th style="text-align:left;padding:4px">Product</th><th style="padding:4px">Rate %</th><th style="padding:4px">Flat ₦</th><th style="padding:4px">Max cap ₦</th><th style="padding:4px">Min ₦</th><th style="padding:4px">VAT %</th></tr></thead><tbody>' +
          channels.map(function(ch) {
            var c = rateByCh[ch[0]] || {};
            var rate = (c.rate !== undefined && c.rate !== null) ? (Number(c.rate)*100) : '';
            var flat = c.flat_fee ? (Number(c.flat_fee)/100) : '';
            var cap  = c.cap ? (Number(c.cap)/100) : '';
            var minc = c.min_charge ? (Number(c.min_charge)/100) : '';
            var vat  = (c.vat_rate !== undefined && c.vat_rate !== null) ? (Number(c.vat_rate)*100) : 7.5;
            var inp = function(f,v,w,st){ return '<input class="form-input" id="em-rc-'+ch[0]+'-'+f+'" type="number" '+(st||'')+' value="'+v+'" style="width:'+(w||70)+'px">'; };
            return '<tr><td style="padding:3px">'+ch[1]+'</td>' +
              '<td style="padding:3px">'+inp('rate',rate,68,'step="0.01" min="0" max="20"')+'</td>' +
              '<td style="padding:3px">'+inp('flat',flat,68,'step="0.01" min="0"')+'</td>' +
              '<td style="padding:3px">'+inp('cap',cap,72,'min="0"')+'</td>' +
              '<td style="padding:3px">'+inp('min',minc,68,'min="0"')+'</td>' +
              '<td style="padding:3px">'+inp('vat',vat,58,'step="0.1" min="0"')+'</td></tr>';
          }).join('') + '</tbody></table></div>' +
          '<div class="form-hint">Enter a Rate % and/or Flat ₦. Max cap / Min are optional. Clear all numeric fields on a row to remove the override (revert to platform default).</div>';
      })() : '<div class="info-box" style="font-size:12px">Per-product rate changes require Super Admin.</div>') +
    '</div>' +
    '<div style="border-top:1px solid var(--gray-100);margin:16px 0;padding-top:16px">' +
      '<div style="font-size:12px;font-weight:600;color:var(--gray-600);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Settlement Account</div>' +
      '<div class="form-grid">' +
        '<div class="form-group"><label class="form-label">Bank Name</label>' +
          '<input class="form-input" id="em-bank" value="' + (m.settlementBank || '') + '" placeholder="e.g. Guaranty Trust Bank"></div>' +
        '<div class="form-group"><label class="form-label">Account Number</label>' +
          '<input class="form-input" id="em-acct" value="' + (m.settlementAccount || '') + '" placeholder="10-digit NUBAN" maxlength="10"></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Account Name <span style="color:var(--red)">*</span></label>' +
        '<input class="form-input" id="em-acct-name" value="' + (m.settlementAccountName || '') + '" placeholder="Must match bank records exactly"></div>' +
      '<div class="warn-box" style="font-size:12px">Changing settlement details triggers a bank name enquiry. Account requires review before payouts resume.</div>' +
    '</div>' +
    adminOnlyFields +
    '<div class="divider"></div>' +
    '<div class="flex-between">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" onclick="saveMerchantEdit(\'' + id + '\')">Save Changes</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

// ── VIEW AGGREGATOR'S MERCHANTS (Super Admin) ─────────────────────────────────
async function viewAggMerchants(aggId) {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/aggregators/' + aggId + '/merchants');
    var merchants = (res && res.data) ? res.data : [];

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div>' +
          '<div class="page-title">Merchant Portfolio</div>' +
          '<div class="page-desc">' + merchants.length + ' merchant' + (merchants.length !== 1 ? 's' : '') + ' under this aggregator</div>' +
        '</div>' +
        '<button class="btn btn-outline btn-sm" onclick="navigate(\'aggregators\')">&#8592; Back to Aggregators</button>' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Code</th><th>Business Name</th><th>Category</th><th>KYC Status</th><th>Rate</th><th>Actions</th></tr></thead>' +
        '<tbody>' +
        (merchants.length ? merchants.map(function(m) {
          var rate = m.processingRate ? (Number(m.processingRate) * 100).toFixed(1) + '%' : '—';
          return '<tr>' +
            '<td class="mono" style="font-size:11px">' + (m.merchantCode || '—') + '</td>' +
            '<td style="font-weight:500">' + m.businessName + '</td>' +
            '<td><span class="tag">' + (m.category || '—') + '</span></td>' +
            '<td>' + statusBadge(m.kycStatus) + '</td>' +
            '<td class="mono">' + rate + '</td>' +
            '<td>' +
              '<button class="btn btn-outline btn-sm" onclick="viewMerchant(\'' + m.id + '\')">View</button>&nbsp;' +
              '<button class="btn btn-outline btn-sm" onclick="editMerchant(\'' + m.id + '\')">&#9998; Edit</button>' +
            '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:20px">No merchants under this aggregator</td></tr>') +
        '</tbody>' +
      '</table></div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load merchants: ' + e.message);
  }
}

function _val(id) { var el = document.getElementById(id); return el ? el.value.trim() : null; }

async function saveMerchantEdit(id) {
  // Fee payer
  var feePayer = document.querySelector('input[name="em-fee-payer"]:checked');

  var body = {
    businessName:          _val('em-name'),
    category:              _val('em-cat'),
    businessEmail:         _val('em-email'),
    businessPhone:         _val('em-phone'),
    rcNumber:              _val('em-rc'),
    address:               _val('em-address'),
    settlementBank:        _val('em-bank'),
    settlementAccount:     _val('em-acct'),
    settlementAccountName: _val('em-acct-name'),
  };
  if (feePayer) body.feePaidBy = feePayer.value;
  // Super-admin-only fields (elements won't exist in aggregator modal)
  if (document.getElementById('em-status')) body.kycStatus      = _val('em-status');
  if (document.getElementById('em-agg'))    body.aggregatorId   = _val('em-agg') || null;

  // Save per-product pricing (full model) — SA only; the inputs exist only then.
  if (document.getElementById('em-rc-CARD_LOCAL-rate')) {
    var num = function(idf){ var e=document.getElementById(idf); var v=e?parseFloat(e.value):NaN; return isNaN(v)?null:v; };
    var channels = ['CARD_LOCAL','CARD_INTL','VIRTUAL_ACCOUNT','USSD','PAYOUT'];
    for (var i=0;i<channels.length;i++) {
      var ch = channels[i];
      var rate=num('em-rc-'+ch+'-rate'), flat=num('em-rc-'+ch+'-flat'), cap=num('em-rc-'+ch+'-cap'), minc=num('em-rc-'+ch+'-min'), vat=num('em-rc-'+ch+'-vat');
      var hasOverride = (rate!==null && rate>0) || (flat!==null && flat>0) || (cap!==null && cap>0) || (minc!==null && minc>0);
      if (hasOverride) {
        await apiFetch('/merchants/'+id+'/rates', { method:'POST', body: JSON.stringify({
          channel: ch, rate: (rate||0)/100, flat_fee: Math.round((flat||0)*100),
          cap: Math.round((cap||0)*100), min_charge: Math.round((minc||0)*100), vat_rate: (vat!=null?vat:7.5)/100 }) });
      } else {
        await apiFetch('/merchants/'+id+'/rates/'+ch, { method:'DELETE' }).catch(function(){});
      }
    }
  }

  var res = await apiFetch('/merchants/' + id, { method: 'PUT', body: JSON.stringify(body) });
  if (res && res.status) {
    alert('Merchant updated successfully');
    document.getElementById('modal').style.display = 'none';
    // Refresh whichever merchant list is currently showing
    if (currentRole === 'aggregator') loadPageData('agg_merchants');
    else loadMerchants();
  } else {
    alert('Error: ' + ((res && res.message) || 'Update failed'));
  }
}

// ── AGGREGATORS ───────────────────────────────────────────────────────────────
async function loadAggregators() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const res = await apiFetch('/aggregators');
    if (!res?.data) { el.innerHTML = errorBox('Could not load aggregators'); return; }

    const aggs = res.data;
    window._aggData = aggs;   // cached for the Edit modal

    el.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <div class="page-title">Aggregators</div>
        <div class="page-desc">${aggs.length} active aggregator partners</div>
      </div>
      <div class="flex" style="gap:6px">
        <button class="btn btn-outline" onclick="inviteAggregator()">&#9993; Invite to Self-Onboard</button>
        <button class="btn btn-lime" onclick="openCreateAggregator()">+ Create Aggregator</button>
      </div>
    </div>
    <div class="grid-2">
      ${aggs.map(a => `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">${a.companyName}</div>
            <div class="card-subtitle">${a.user?.email||''}</div>
          </div>
          ${statusBadge(a.status)}
        </div>
        <div class="rev-row"><span class="rev-label">RC Number</span><span class="rev-value mono">${a.rcNumber||'—'}</span></div>
        <div class="rev-row"><span class="rev-label">Revenue Split</span><span class="rev-value">${(Number(a.revenueSplitPct)*100).toFixed(0)}%</span></div>
        <div class="rev-row"><span class="rev-label">Merchants</span><span class="rev-value">${a.merchant_count||0}</span></div>
        <div class="rev-row"><span class="rev-label">Settlement Bank</span><span class="rev-value">${a.settlementBank||'—'}</span></div>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-lime btn-sm" onclick="editAggregator('${a.id}')">&#9998; Edit</button>
          <button class="btn btn-outline btn-sm" onclick="editSplit('${a.id}','${a.revenueSplitPct}')">Edit Split</button>
          <button class="btn btn-outline btn-sm" onclick="viewAggRates('${a.id}','${a.companyName}')">Rate Config</button>
          <button class="btn btn-outline btn-sm" onclick="viewAggMerchants('${a.id}')">View Merchants</button>
          <button class="btn btn-outline btn-sm" onclick="openDocsModal('aggregator','${a.id}','${(a.companyName||'').replace(/'/g,'')}')">&#128196; Documents</button>
          <button class="btn btn-outline btn-sm" style="color:#fff;background:var(--red);border-color:var(--red)" onclick="deleteAggregator('${a.id}','${(a.companyName||'').replace(/'/g,'')}')">&#128465; Delete</button>
        </div>
      </div>`).join('')}
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load aggregators: ' + e.message);
  }
}

// ── SA: invite an aggregator to self-onboard (they fill the form themselves) ──
function inviteAggregator() {
  showModal(
    '<div class="modal-header"><div class="modal-title">Invite Aggregator to Self-Onboard</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="font-size:12px;margin-bottom:12px">Sends a link to the public onboarding form (aggregator). They complete it themselves; on approval their aggregator account is provisioned.</div>' +
    '<div class="form-group"><label class="form-label">Aggregator / Company Name *</label><input class="form-input" id="iagg-name" placeholder="e.g. FinConnect Nigeria"></div>' +
    '<div class="form-group"><label class="form-label">Email *</label><input class="form-input" id="iagg-email" type="email" placeholder="contact@company.com"></div>' +
    '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="iagg-phone" placeholder="+234 800 000 0000"></div>' +
    '<div id="iagg-msg"></div>' +
    '<div class="flex-between" style="margin-top:8px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" id="iagg-btn" onclick="submitInviteAggregator()">Send Invite</button></div>');
}
async function submitInviteAggregator() {
  var name = (document.getElementById('iagg-name').value||'').trim();
  var email = (document.getElementById('iagg-email').value||'').trim();
  var phone = (document.getElementById('iagg-phone').value||'').trim();
  var msg = document.getElementById('iagg-msg');
  if (!name || !email) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Name and email are required.</div>'; return; }
  var btn = document.getElementById('iagg-btn'); btn.disabled = true; btn.textContent = 'Sending...';
  var res = await apiFetch('/onboarding/invite', { method:'POST', body: JSON.stringify({ type:'aggregator', name:name, email:email, phone:phone }) });
  if (res && res.status) { msg.innerHTML = '<div class="info-box" style="font-size:12px;background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Invite sent to ' + email + '.</div>'; setTimeout(function(){ document.getElementById('modal').style.display='none'; }, 1200); }
  else { msg.innerHTML = '<div class="warn-box" style="font-size:12px">' + ((res&&res.message)||'Failed') + '</div>'; btn.disabled=false; btn.textContent='Send Invite'; }
}

// ── SA: create aggregator ─────────────────────────────────────────────────────
function openCreateAggregator() {
  showModal(
    '<div class="modal-header"><div class="modal-title">Create Aggregator</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Company Name <span style="color:var(--red)">*</span></label><input class="form-input" id="agg-company" placeholder="Registered company name"></div>' +
    '<div class="form-group"><label class="form-label">Contact Email <span style="color:var(--red)">*</span></label><input class="form-input" type="email" id="agg-email" placeholder="ops@company.com"></div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Contact Name</label><input class="form-input" id="agg-contact" placeholder="Full name"></div>' +
      '<div class="form-group"><label class="form-label">RC Number</label><input class="form-input" id="agg-rc" placeholder="RC 000000"></div>' +
    '</div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Revenue Split %</label><input class="form-input" type="number" id="agg-split" min="0" max="100" placeholder="e.g. 30"></div>' +
      '<div class="form-group"><label class="form-label">Settlement Bank</label><input class="form-input" id="agg-bank" placeholder="e.g. GTBank"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Settlement Account</label><input class="form-input" id="agg-acct" placeholder="10-digit NUBAN"></div>' +
    '<div class="warn-box" style="font-size:12px;margin-bottom:14px">A user account is created and emailed a temporary password. The aggregator must change it on first sign-in.</div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" id="agg-create-btn" onclick="submitCreateAggregator()">Create Aggregator</button></div>'
  );
}
async function submitCreateAggregator() {
  var body = {
    company_name: (document.getElementById('agg-company').value||'').trim(),
    email: (document.getElementById('agg-email').value||'').trim(),
    contact_name: (document.getElementById('agg-contact').value||'').trim(),
    rc_number: (document.getElementById('agg-rc').value||'').trim(),
    split_pct: document.getElementById('agg-split').value,
    settlement_bank: (document.getElementById('agg-bank').value||'').trim(),
    settlement_account: (document.getElementById('agg-acct').value||'').trim(),
  };
  if (!body.company_name || !body.email) { alert('Company name and email are required'); return; }
  var btn = document.getElementById('agg-create-btn'); btn.textContent='Creating...'; btn.disabled=true;
  var res = await apiFetch('/aggregators', { method:'POST', body: JSON.stringify(body) });
  if (res && res.status) {
    document.getElementById('modal').style.display='none';
    alert('Aggregator created. A temporary password was emailed to ' + body.email + '.');
    loadAggregators();
  } else { alert('Error: ' + ((res && res.message) || 'Create failed')); btn.textContent='Create Aggregator'; btn.disabled=false; }
}

// ── SA: re-issue first-time password ──────────────────────────────────────────
async function resetTempPassword(userId, email) {
  if (!confirm('Re-issue a temporary password for ' + email + '? It will be emailed and they must change it on next sign-in.')) return;
  var res = await apiFetch('/users/' + userId + '/reset-temp-password', { method:'POST' });
  if (res && res.status) alert('Temporary password re-issued and emailed to ' + email + '.');
  else alert('Error: ' + ((res && res.message) || 'Reset failed'));
}

// ── AGGREGATOR RATE CONFIG ────────────────────────────────────────────────────

async function viewAggRates(aggId, aggName) {
  var res = await apiFetch('/aggregators/' + aggId + '/rates');
  if (!res || !res.data) { alert('Could not load rate config'); return; }
  var d = res.data;
  var overrides = d.overrides || [];

  var rows = overrides.length === 0
    ? '<tr><td colspan="3" style="text-align:center;color:var(--gray-400);padding:16px">No per-merchant overrides — all merchants use default split</td></tr>'
    : overrides.map(function(o) {
        return '<tr>' +
          '<td>' + (o.merchant ? o.merchant.businessName + ' <span style="font-size:11px;color:var(--gray-400)">(' + o.merchant.merchantCode + ')</span>' : 'All') + '</td>' +
          '<td>' + (Number(o.split_pct) * 100).toFixed(1) + '%</td>' +
          '<td><button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="removeAggRateOverride(\'' + aggId + '\',\'' + o.merchant_id + '\')">Remove</button></td>' +
        '</tr>';
      }).join('');

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">Rate Config — ' + (aggName || 'Aggregator') + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    '<div class="rev-row"><span class="rev-label">Default Split</span><span class="rev-value" style="font-size:16px;font-weight:700">' + (Number(d.default_split_pct)*100).toFixed(1) + '%</span></div>' +
    '<div style="font-size:12px;color:var(--gray-400);margin-bottom:16px">Applies to all merchants unless overridden below</div>' +
    '<div style="font-weight:600;font-size:13px;margin-bottom:8px">Per-Merchant Overrides</div>' +
    '<table class="data-table" style="width:100%;margin-bottom:16px"><thead><tr><th>Merchant</th><th>Split %</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="divider"></div>' +
    '<div style="font-weight:600;font-size:13px;margin-bottom:10px">Add / Update Override</div>' +
    '<div class="form-grid" style="grid-template-columns:2fr 1fr;gap:10px;margin-bottom:10px">' +
      '<div><label class="form-label">Merchant ID (leave blank to update default)</label>' +
        '<input class="form-input" id="ar-merchant" placeholder="Merchant UUID or leave blank for default"></div>' +
      '<div><label class="form-label">Split % (e.g. 30 for 30%)</label>' +
        '<input class="form-input" type="number" id="ar-split" value="' + (Number(d.default_split_pct)*100).toFixed(1) + '" step="0.5" min="0" max="100"></div>' +
    '</div>' +
    '<div style="margin-bottom:12px"><label class="form-label">Notes</label><input class="form-input" id="ar-notes" placeholder="Optional"></div>' +
    '<div style="display:flex;gap:8px">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Close</button>' +
      '<button class="btn btn-lime" onclick="saveAggRateOverride(\'' + aggId + '\',\'' + (aggName||'').replace(/'/g,'') + '\')">Save</button>' +
    '</div>';

  document.getElementById('modal').style.display = 'flex';
}

async function saveAggRateOverride(aggId, aggName) {
  var merchantId = (document.getElementById('ar-merchant').value || '').trim() || null;
  var splitPct   = parseFloat(document.getElementById('ar-split').value) / 100;
  var notes      = document.getElementById('ar-notes').value;
  if (isNaN(splitPct) || splitPct < 0 || splitPct > 1) { alert('Split must be 0–100'); return; }

  var res = await apiFetch('/aggregators/' + aggId + '/rates', {
    method: 'POST',
    body: JSON.stringify({ merchant_id: merchantId, split_pct: splitPct, notes }),
  });
  if (res && res.status) {
    viewAggRates(aggId, aggName);
  } else {
    alert('Error: ' + ((res && res.message) || 'Save failed'));
  }
}

async function removeAggRateOverride(aggId, merchantId) {
  if (!confirm('Remove this per-merchant split override?')) return;
  var res = await apiFetch('/aggregators/' + aggId + '/rates/' + merchantId, { method: 'DELETE' });
  if (res && res.status) viewAggRates(aggId);
  else alert('Error: ' + ((res && res.message) || 'Remove failed'));
}

// ── ACTIVITY LOG (SA + Audit) — staff vs customer, filterable ──────────────────
function _actRoleBadge(role) {
  var m = { SUPER_ADMIN:'badge-purple', ADMIN:'badge-blue', COMPLIANCE_OFFICER:'badge-amber',
            AUDIT:'badge-gray', MERCHANT:'badge-green', AGGREGATOR:'badge-lime' };
  var lbl = { SUPER_ADMIN:'Super Admin', ADMIN:'Admin', COMPLIANCE_OFFICER:'Compliance',
              AUDIT:'Audit', MERCHANT:'Merchant', AGGREGATOR:'Aggregator' };
  return '<span class="badge ' + (m[role]||'badge-gray') + '">' + (lbl[role]||role||'—') + '</span>';
}

async function loadActivityLog(tab) {
  var el = document.getElementById('main-content');
  if (!el) return;
  tab = tab || window._actLogTab || 'staff';
  window._actLogTab = tab;
  // Read filters BEFORE wiping the DOM.
  var q      = (document.getElementById('actlog-q')      || {}).value || '';
  var from   = (document.getElementById('actlog-from')   || {}).value || '';
  var to     = (document.getElementById('actlog-to')     || {}).value || '';
  var action = (document.getElementById('actlog-action') || {}).value || '';
  var role   = (document.getElementById('actlog-role')   || {}).value || '';
  el.innerHTML = loading();
  try {
    var qs = 'actorType=' + tab + '&perPage=200';
    if (q)      qs += '&q='      + encodeURIComponent(q);
    if (from)   qs += '&from='   + encodeURIComponent(from);
    if (to)     qs += '&to='     + encodeURIComponent(to);
    if (action) qs += '&action=' + encodeURIComponent(action);
    if (role)   qs += '&role='   + encodeURIComponent(role);
    var res = await apiFetch('/admin/audit-log?' + qs);
    if (!res || !res.status) { el.innerHTML = errorBox((res && res.message) || 'Failed to load activity log'); return; }
    var rows = res.data || [];
    window._actLogRows = rows;

    var tabBtn = function(id, label) {
      return '<button class="tab-btn ' + (tab === id ? 'active' : '') + '" onclick="loadActivityLog(\'' + id + '\')">' + label + '</button>';
    };
    var body = rows.length ? rows.map(function(r, i) {
      var entity = _escA(r.entity_type || '') + (r.entity_id ? ' <span class="mono" style="font-size:11px;color:var(--gray-400)">' + _escA(String(r.entity_id).slice(0,8)) + '</span>' : '');
      var hasDetail = r.before || r.after || r.notes;
      return '<tr>' +
        '<td style="font-size:12px;white-space:nowrap">' + new Date(r.created_at).toLocaleString('en-NG') + '</td>' +
        '<td><div style="font-weight:500">' + _escA(r.actor ? r.actor.name : '—') + '</div>' +
          '<div style="font-size:11px;color:var(--gray-400)">' + _escA(r.actor ? r.actor.email : '') + '</div></td>' +
        '<td>' + (r.actor ? _actRoleBadge(r.actor.role) : '—') + '</td>' +
        '<td><span class="tag">' + _escA(r.action) + '</span></td>' +
        '<td style="font-size:12px">' + entity + '</td>' +
        '<td class="mono" style="font-size:11px">' + _escA(r.ip || '—') + '</td>' +
        '<td>' + (hasDetail ? '<button class="btn btn-outline btn-sm" onclick="viewActivityDetail(' + i + ')">View</button>' : '<span style="color:var(--gray-400);font-size:12px">—</span>') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No activity found for these filters</td></tr>';

    el.innerHTML =
      '<div class="page-header"><div class="page-title">Activity Log</div>' +
        '<div class="page-desc">Who did what, when &mdash; staff and customer activity (' + (res.meta ? res.meta.total : rows.length) + ' total)</div></div>' +
      '<div class="tab-nav">' + tabBtn('staff','Staff Activity') + tabBtn('customer','Customer Activity') + '</div>' +
      '<div class="card" style="margin-bottom:12px"><div class="flex" style="gap:8px;align-items:flex-end;flex-wrap:wrap">' +
        '<div class="form-group" style="margin:0"><label class="form-label">Action</label><select class="form-input form-select" id="actlog-action" style="width:190px" onchange="loadActivityLog(\'' + tab + '\')">' +
          '<option value="">All actions</option>' + ((res.meta && res.meta.actions) || []).map(function(a){ return '<option value="' + _escA(a) + '"' + (action===a?' selected':'') + '>' + _escA(a.replace(/_/g,' ')) + '</option>'; }).join('') + '</select></div>' +
        '<div class="form-group" style="margin:0"><label class="form-label">Role</label><select class="form-input form-select" id="actlog-role" style="width:150px" onchange="loadActivityLog(\'' + tab + '\')">' +
          ['','SUPER_ADMIN','ADMIN','COMPLIANCE_OFFICER','AUDIT','MERCHANT','AGGREGATOR'].map(function(rr){ return '<option value="' + rr + '"' + (role===rr?' selected':'') + '>' + (rr?rr.replace(/_/g,' '):'All roles') + '</option>'; }).join('') + '</select></div>' +
        '<div class="form-group" style="margin:0"><label class="form-label">Search</label><input class="form-input" id="actlog-q" style="width:180px" value="' + _escA(q) + '" placeholder="entity, email…" onkeydown="if(event.key===\'Enter\')loadActivityLog(\'' + tab + '\')"></div>' +
        '<div class="form-group" style="margin:0"><label class="form-label">From</label><input type="date" class="form-input" id="actlog-from" value="' + _escA(from) + '" onchange="loadActivityLog(\'' + tab + '\')"></div>' +
        '<div class="form-group" style="margin:0"><label class="form-label">To</label><input type="date" class="form-input" id="actlog-to" value="' + _escA(to) + '" onchange="loadActivityLog(\'' + tab + '\')"></div>' +
        '<button class="btn btn-lime btn-sm" onclick="loadActivityLog(\'' + tab + '\')">Apply</button>' +
        '<button class="btn btn-outline btn-sm" onclick="[\'actlog-q\',\'actlog-from\',\'actlog-to\',\'actlog-action\',\'actlog-role\'].forEach(function(id){var x=document.getElementById(id);if(x)x.value=\'\';});loadActivityLog(\'' + tab + '\')">Clear</button>' +
      '</div></div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Entity</th><th>IP</th><th></th></tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table></div></div>';
  } catch (e) {
    el.innerHTML = errorBox('Failed to load activity log: ' + (e && e.message ? e.message : e));
  }
}

function viewActivityDetail(i) {
  var r = (window._actLogRows || [])[i];
  if (!r) return;
  var fmt = function(o) { try { return o ? '<pre style="white-space:pre-wrap;font-size:11px;background:var(--gray-50);padding:10px;border-radius:8px;overflow:auto">' + _escA(JSON.stringify(o, null, 2)) + '</pre>' : '<span style="color:var(--gray-400)">—</span>'; } catch(e){ return '—'; } };
  showModal(
    '<div class="modal-header"><div class="modal-title">' + _escA(r.action) + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="rev-row"><span class="rev-label">When</span><span class="rev-value">' + new Date(r.created_at).toLocaleString('en-NG') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Actor</span><span class="rev-value">' + _escA(r.actor ? (r.actor.name + ' (' + r.actor.email + ')') : '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Entity</span><span class="rev-value">' + _escA((r.entity_type||'') + ' ' + (r.entity_id||'')) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">IP</span><span class="rev-value mono">' + _escA(r.ip || '—') + '</span></div>' +
    (r.notes ? '<div class="rev-row"><span class="rev-label">Notes</span><span class="rev-value">' + _escA(r.notes) + '</span></div>' : '') +
    '<div class="divider"></div>' +
    '<div style="font-weight:600;font-size:12px;margin-bottom:4px">Before</div>' + fmt(r.before) +
    '<div style="font-weight:600;font-size:12px;margin:10px 0 4px">After</div>' + fmt(r.after)
  );
}

// ── KYC REVIEW (domestic) — merchant register + KYC queue + AML flags ──────────
// Actor matrix: Compliance Officer PASSES merchants for activation (approve/reject/verify docs),
// alongside SA + Admin. Only DOCUMENT DEFERRAL (activate despite outstanding docs) is SA-only.
function _complianceCanDecide() { return ['superadmin','admin','compliance'].indexOf(currentRole) !== -1; }

// 3-panel tab switch for the KYC Review page.
function cmplReviewTab(btn, panelId) {
  var wrap = document.getElementById('cmpl-review-tabs');
  if (wrap) wrap.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  ['cmpl-merchants','cmpl-kyc','cmpl-aml'].forEach(function(p){
    var e = document.getElementById(p); if (e) e.style.display = (p === panelId ? 'block' : 'none');
  });
}

// PEP / MATCH / compliance-status badge for a merchant row.
function _mComplianceBadge(m) {
  if (m.matchListed) return '<span class="badge badge-red" title="MATCH/TMF listed">MATCH</span>';
  var s = (m.complianceStatus || '').toLowerCase();
  if (s === 'blocked') return '<span class="badge badge-red">Blocked</span>';
  if (s === 'review')  return '<span class="badge badge-amber">Review</span>';
  if (s === 'clear')   return '<span class="badge badge-green">Clear</span>';
  return '<span class="badge badge-gray">—</span>';
}

async function loadCompliance() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  const canDecide = _complianceCanDecide();
  try {
    const [queueR, flagsR, merchantsR] = await Promise.allSettled([
      apiFetch('/kyc/queue?status=submitted&perPage=20'),
      apiFetch('/reports/aml-flags?riskLevel=HIGH'),
      apiFetch('/merchants?perPage=200'),
    ]);
    const submissions  = (queueR.status === 'fulfilled' && queueR.value?.data?.submissions) || [];
    const amlFlags     = (flagsR.status === 'fulfilled' && flagsR.value?.data) || [];
    const allMerchants = (merchantsR.status === 'fulfilled' && merchantsR.value?.data) || [];

    const merchantRows = allMerchants.length ? allMerchants.map(function(m){
      var name = _escA(m.businessName || '—');
      var docsBtn = '<button class="btn btn-outline btn-sm" onclick="openDocsModal(\'merchant\',\'' + m.id + '\',\'' + _escA((m.businessName||'').replace(/\x27/g,'')) + '\')">' + (canDecide ? 'Docs' : 'View') + '</button>';
      var manageBtn = canDecide ? ' <button class="btn btn-outline btn-sm" onclick="openMerchantDetail(\'' + m.id + '\')">Manage</button>' : '';
      return '<tr>' +
        '<td><div style="font-weight:500">' + name + '</div><div style="font-size:11px;color:var(--gray-400)">' + _escA(m.merchantCode||'') + '</div></td>' +
        '<td>' + statusBadge(m.kycStatus) + '</td>' +
        '<td>' + _mComplianceBadge(m) + '</td>' +
        '<td>' + (m.isActive ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>') + '</td>' +
        '<td style="white-space:nowrap">' + docsBtn + manageBtn + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px">No merchants</td></tr>';

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">KYC Review</div>
      <div class="page-desc">Domestic merchant KYC, AML &amp; PEP${canDecide ? '' : ' — read-only'}</div>
    </div>
    <div class="tab-nav" id="cmpl-review-tabs">
      <button class="tab-btn active" onclick="cmplReviewTab(this,'cmpl-merchants')">All Merchants (${allMerchants.length})</button>
      <button class="tab-btn" onclick="cmplReviewTab(this,'cmpl-kyc')">KYC Queue (${submissions.length})</button>
      <button class="tab-btn" onclick="cmplReviewTab(this,'cmpl-aml')">AML Flags (${amlFlags.length})</button>
    </div>
    <div id="cmpl-merchants">
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Merchant</th><th>KYC Status</th><th>Compliance / PEP</th><th>Account</th><th>Actions</th></tr></thead>
        <tbody>${merchantRows}</tbody>
      </table></div></div>
    </div>
    <div id="cmpl-kyc" style="display:none">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Merchant</th><th>Category</th><th>Tier</th><th>Aggregator</th><th>Addr Check</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>
              ${submissions.length ? submissions.map(s => {
                const addrStatus = s.addr_check_status || 'pending';
                const addrBadge  = addrStatus === 'passed'  ? '<span class="badge badge-green">&#10003; Verified</span>' :
                                   addrStatus === 'failed'  ? '<span class="badge badge-red">&#10007; Failed</span>' :
                                                              '<span class="badge badge-amber">Pending</span>';
                return `<tr>
                <td><div style="font-weight:500">${_escA(s.merchant.name)}</div><div style="font-size:11px;color:var(--gray-400)">${_escA(s.merchant.code)}</div></td>
                <td>${_escA(s.merchant.category||'')}</td>
                <td><span class="badge badge-blue">Tier ${s.tier_applied}</span></td>
                <td>${_escA(s.merchant.aggregator||'Direct')}</td>
                <td>${addrBadge}</td>
                <td style="font-size:12px">${new Date(s.submitted_at).toLocaleDateString('en-NG')}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-outline btn-sm" onclick="showAddrVerification('${s.id}','${addrStatus}','${s.addr_report_url||''}')">&#128205; Addr</button>
                  ${canDecide ? `<button class="btn btn-lime btn-sm" onclick="approveKyc('${s.id}')">Approve</button>
                  <button class="btn btn-outline btn-sm" onclick="rejectKyc('${s.id}')">Reject</button>` : ''}
                </td>
              </tr>`;}).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No pending KYC submissions</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div id="cmpl-aml" style="display:none">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Merchant</th><th>Flag Type</th><th>Risk Level</th><th>Transaction</th><th>Description</th><th>Raised</th></tr></thead>
            <tbody>
              ${amlFlags.length ? amlFlags.map(f => `<tr>
                <td style="font-weight:500">${_escA(f.merchant?.businessName||'—')}</td>
                <td><span class="tag">${_escA(f.flag_type)}</span></td>
                <td>${statusBadge(f.risk_level?.toLowerCase())}</td>
                <td class="mono" style="font-size:11px">${_escA(f.transaction?.reference||'—')}</td>
                <td style="font-size:12px">${_escA(f.description||'—')}</td>
                <td style="font-size:12px">${new Date(f.created_at).toLocaleDateString('en-NG')}</td>
              </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:20px">No open AML flags</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load compliance data: ' + e.message);
  }
}

// ── REPORTS — REVENUE ─────────────────────────────────────────────────────────
async function loadRevenueReport() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const now   = new Date();
    const from  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const to    = now.toISOString().split('T')[0];

    const [rev, agg] = await Promise.all([
      apiFetch(`/reports/revenue?from=${from}&to=${to}&groupBy=day`),
      apiFetch(`/reports/aggregator-revenue?month=${from.slice(0,7)}`),
    ]);

    const rowsNGN = rev?.data?.data_ngn || rev?.data?.data || [];
    const rowsUSD = rev?.data?.data_usd || [];
    const aggRows = agg?.data?.data || [];

    const sum = (rows, key) => rows.reduce((s,r)=>s+(Number(r[key])||0),0);

    const breakdownCard = (title, rows, ccy) =>
      `<div class="card"${ccy==='USD'?' style="border:1px solid #bfdbfe"':''}>
        <div class="card-header"><div class="card-title">${title}</div>${ccy==='USD'?intlBadge():ccyChip('NGN')}</div>
        ${rows.length ? rows.slice(0,12).map(r => `
        <div class="rev-row">
          <span class="rev-label">${(r.period||'').slice(0,10)||'—'} · ${r.product||r.channel} <span style="color:var(--gray-400)">(${fmtNum(r.txn_count)})</span></span>
          <div style="text-align:right">
            <div style="font-weight:600;font-size:13px">Gross ${fmtMajor(r.gross_revenue, ccy)}</div>
            <div style="font-size:11px;color:var(--gray-400)">Rail ${fmtMajor(r.rail_costs, ccy)} · Margin ${fmtMajor(r.paylode_margin, ccy)} · Net VAT ${fmtMajor(r.net_vat, ccy)}</div>
          </div>
        </div>`).join('') : `<div style="color:var(--gray-400);padding:24px;text-align:center">No ${ccy==='USD'?'international (USD)':'local (NGN)'} revenue this period.</div>`}
      </div>`;

    el.innerHTML = `
    <div class="page-header flex-between">
      <div>
        <div class="page-title">Revenue Report</div>
        <div class="page-desc">Earnings this month — local &amp; international reported separately — ${from} to ${to}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="navigate('fee_config')">⚙ Configure Rates →</button>
    </div>
    <div class="info-box" style="margin-bottom:16px;font-size:12px">This page <strong>reports</strong> earned revenue. Set rates in <strong>Merchant Pricing</strong>. International card revenue is shown in <strong>USD</strong>, separate from local NGN revenue.</div>

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-gray">₦ Local (NGN)</span><span style="font-size:12px;color:var(--gray-400)">Gross Revenue − Rail Costs = Margin · VAT shown net (output − input)</span></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Volume (gross collected)</div><div class="stat-value">${fmtMajor(sum(rowsNGN,'volume_major'),'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Gross Revenue</div><div class="stat-value">${fmtMajor(sum(rowsNGN,'gross_revenue'),'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Rail Costs</div><div class="stat-value text-red">${fmtMajor(sum(rowsNGN,'rail_costs'),'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Paylode Margin</div><div class="stat-value text-lime">${fmtMajor(sum(rowsNGN,'paylode_margin'),'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Net VAT Payable</div><div class="stat-value">${fmtMajor(sum(rowsNGN,'net_vat'),'NGN')}</div></div>
    </div>

    <div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-blue">🌍 International (USD)</span><span style="font-size:12px;color:var(--gray-400)">International card revenue — settled in US Dollars</span></div>
    <div class="stats-grid">
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Gross Revenue (USD)</div><div class="stat-value">${fmtMajor(sum(rowsUSD,'gross_revenue'),'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Paylode Margin (USD)</div><div class="stat-value" style="color:#1e40af">${fmtMajor(sum(rowsUSD,'paylode_margin'),'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Volume (USD)</div><div class="stat-value">${fmtMajor(sum(rowsUSD,'volume_major'),'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Intl Transactions</div><div class="stat-value">${fmtNum(sum(rowsUSD,'txn_count'))}</div></div>
    </div>

    <div class="grid-2 section-gap">
      ${breakdownCard('NGN — Daily Breakdown', rowsNGN, 'NGN')}
      ${breakdownCard('USD — Daily Breakdown', rowsUSD, 'USD')}
    </div>
    <div class="card section-gap">
      <div class="card-header"><div class="card-title">Aggregator Revenue Share (NGN)</div></div>
      ${aggRows.length ? aggRows.map(a => `
      <div class="rev-row">
        <div><div style="font-weight:500;font-size:13px">${a.company_name}</div>
          <div style="font-size:11px;color:var(--gray-400)">${a.split_pct} split · ${a.merchant_count} merchants</div></div>
        <div style="text-align:right"><div style="font-weight:600;font-size:13px">${fmtMajor(a.agg_payout_due,'NGN')}</div>
          <div style="font-size:11px;color:var(--gray-400)">Due this month</div></div>
      </div>`).join('') : '<div style="color:var(--gray-400);padding:24px;text-align:center">No aggregator payouts due this month.</div>'}
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load revenue data: ' + e.message);
  }
}

// ── SETTLEMENTS ───────────────────────────────────────────────────────────────
async function loadSettlements() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const res = await apiFetch('/settlements');
    const settlements = res?.data || [];

    var sandboxToggle = '<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">' +
      '<input type="checkbox" id="settle-sandbox" onchange="loadSettlements()"> Include sandbox</label>';
    var isSandbox = document.getElementById('settle-sandbox') && document.getElementById('settle-sandbox').checked;

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div><div class="page-title">Settlements</div><div class="page-desc">Merchant disbursement records</div></div>' +
        '<div class="flex" style="gap:8px">' + sandboxToggle +
          '<button class="btn btn-outline btn-sm" onclick="runSettlement()">Run Batch (Live)</button>' +
          '<button class="btn btn-primary btn-sm" onclick="runSandboxSettlement()">Run Batch (Sandbox)</button>' +
        '</div>' +
      '</div>' +
      '<div class="info-box" style="margin-bottom:12px;font-size:12px">Settlements are generated <strong>per currency</strong>. International card transactions settle in <strong>USD</strong> on their own settlement lines (marked 🌍).</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Ref</th><th>Merchant</th><th>Currency</th><th>Period</th><th>Txns</th><th>Gross</th><th>Fees</th><th>Net to Merchant</th><th>Status</th><th>Action</th></tr></thead>' +
        '<tbody>' +
        (settlements.length ? settlements.map(function(s) {
          var ccy = s.currency || 'NGN';
          var st  = (s.status||'').toUpperCase();
          // Fire = release money via a payout rail (auto). Only unpaid NGN settlements.
          var fireBtn = ((st === 'PENDING' || st === 'FAILED') && ccy === 'NGN')
            ? '<button class="btn btn-primary btn-sm" onclick="fireSettlementModal(\'' + s.id + '\',\'' + (s.settlementRef||'') + '\',' + (s.net_major||0) + ',\'' + ccy + '\')">Fire</button> '
            : '';
          var markPaid = (s.status !== 'COMPLETED' && s.status !== 'SETTLED')
            ? '<button class="btn btn-lime btn-sm" onclick="markSettlementPaid(\'' + s.id + '\',\'' + (s.merchant && s.merchant.businessName ? s.merchant.businessName.replace(/'/g,'') : '') + '\',' + (s.net_major||0) + ')">Mark Paid</button>'
            : '<span style="color:var(--green);font-size:12px">&#10003; Paid</span>';
          return '<tr' + (ccy==='USD'?' style="background:#f8fbff"':'') + '>' +
            '<td class="mono" style="font-size:10px">' + (s.settlementRef||'—') + '</td>' +
            '<td style="font-weight:500;font-size:12px">' + (s.merchant && s.merchant.businessName ? s.merchant.businessName : '—') + '</td>' +
            '<td>' + (ccy==='USD' ? intlBadge() : ccyChip('NGN')) + '</td>' +
            '<td style="font-size:11px">' + (s.periodStart ? String(s.periodStart).slice(0,10) : '—') + '</td>' +
            '<td style="text-align:center">' + (s.txnCount||0) + '</td>' +
            '<td class="mono" style="font-size:12px">' + (s.gross_display || fmtMajor(s.gross_major||0, ccy)) + '</td>' +
            '<td class="mono text-red" style="font-size:12px">' + (s.fees_display || fmtMajor(s.fees_major||0, ccy)) + '</td>' +
            '<td class="mono" style="font-size:12px;font-weight:700">' + (s.net_display || fmtMajor(s.net_major||0, ccy)) + '</td>' +
            '<td>' + statusBadge((s.status||'pending').toLowerCase()) + '</td>' +
            '<td>' + fireBtn + markPaid + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:24px">No settlement records yet — run a batch to generate</td></tr>') +
        '</tbody>' +
      '</table></div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load settlements: ' + e.message);
  }
}

// ── SA: CONNECTIONS / merchant activity overview (sandbox vs live) ─────────────
async function loadMerchantActivity() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/reports/merchant-activity');
    var d = (res && res.data) || {};
    var s = d.summary || {};
    var rows = d.merchants || [];
    var when = function(x){ return x ? new Date(x).toLocaleString() : '—'; };
    var card = function(label, val){ return '<div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--gray-400);text-transform:uppercase;letter-spacing:.4px">' + label + '</div><div style="font-size:22px;font-weight:700">' + val + '</div></div>'; };
    var body = rows.length ? rows.map(function(m){
      var mode = '';
      if (m.live_txns > 0 || m.live_last_used)       mode += '<span style="color:var(--green,#16a34a);font-weight:600;font-size:11px">Live</span> ';
      if (m.sandbox_txns > 0 || m.sandbox_last_used) mode += '<span style="color:var(--gray-500,#64748b);font-size:11px">Sandbox</span>';
      return '<tr>' +
        '<td style="font-weight:500;font-size:12px">' + (m.business_name || '—') + '</td>' +
        '<td>' + (mode || '<span style="color:var(--gray-400)">—</span>') + '</td>' +
        '<td style="font-size:11px">' + when(m.last_seen) + '</td>' +
        '<td style="text-align:center">' + (m.live_txns || 0) + '</td>' +
        '<td style="text-align:center">' + (m.sandbox_txns || 0) + '</td>' +
        '<td style="font-size:11px">' + when(m.live_last_used) + '</td>' +
        '<td style="font-size:11px">' + when(m.sandbox_last_used) + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:24px">No merchant activity yet</td></tr>';
    el.innerHTML =
      '<div class="page-header"><div class="page-title">Connections</div>' +
        '<div class="page-desc">Who connected, when, and what they\'ve done — sandbox vs live (global overview)</div></div>' +
      '<div class="flex" style="gap:12px;margin-bottom:14px;flex-wrap:wrap">' +
        card('Merchants', s.total_merchants || 0) + card('Live-active', s.live_active || 0) +
        card('Sandbox-active', s.sandbox_active || 0) + card('Active (7d)', s.active_7d || 0) +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Merchant</th><th>Mode</th><th>Last seen</th><th>Live txns</th><th>Sandbox txns</th><th>Live key used</th><th>Sandbox key used</th></tr></thead>' +
        '<tbody>' + body + '</tbody>' +
      '</table></div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load connections: ' + e.message);
  }
}

// ── MERCHANT SETTLEMENTS (merchant role) ──────────────────────────────────────
async function loadMerchSettlements() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var now = new Date();
    var mon = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    var res = await apiFetch('/settlements');
    var settlements = (res && res.data) ? (Array.isArray(res.data) ? res.data : []) : [];

    var rows = settlements.length ? settlements.map(function(s) {
      var ccy = s.currency || 'NGN';
      return '<tr' + (ccy==='USD'?' style="background:#f8fbff"':'') + '>' +
        '<td class="mono" style="font-size:11px">' + (s.settlementRef||'—') + '</td>' +
        '<td>' + (ccy==='USD' ? intlBadge() : ccyChip('NGN')) + '</td>' +
        '<td style="font-size:12px">' + (s.periodStart ? String(s.periodStart).slice(0,10) : '—') + '</td>' +
        '<td style="text-align:center">' + (s.txnCount||0) + '</td>' +
        '<td style="font-weight:600">' + (s.net_display || fmtMajor(s.net_major||0, ccy)) + '</td>' +
        '<td style="font-size:12px">' + (s.merchant&&s.merchant.settlementBank ? s.merchant.settlementBank + (s.merchant.settlementAccount ? ' ****' + String(s.merchant.settlementAccount).slice(-4) : '') : '—') + '</td>' +
        '<td>' + statusBadge((s.status||'pending').toLowerCase()) + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--gray-400)">No settlement records yet</td></tr>';

    el.innerHTML =
      '<div class="page-header"><div class="page-title">Settlements</div>' +
        '<div class="page-desc">Your disbursement records and monthly statements</div></div>' +
      '<div class="card" style="margin-bottom:16px">' +
        '<div class="card-header"><div class="card-title">Monthly Statement</div></div>' +
        '<div class="flex" style="gap:10px;align-items:center;flex-wrap:wrap">' +
          '<input class="form-input" type="month" id="stmt-month" value="' + mon + '" style="width:180px">' +
          '<button class="btn btn-lime btn-sm" onclick="downloadStatement()">&#8681; Download PDF</button>' +
          '<button class="btn btn-outline btn-sm" onclick="emailStatement()">&#9993; Email to Me</button>' +
        '</div>' +
        '<div class="form-hint" style="margin-top:8px">Statement is generated from live transaction data for the selected month.</div>' +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">Settlement History</div>' +
        '<span style="font-size:11px;color:var(--gray-400)">International (USD) card settlements shown separately 🌍</span></div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr><th>Ref</th><th>Currency</th><th>Period</th><th>Transactions</th><th>Amount Settled</th><th>Destination</th><th>Status</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
      '</div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load settlements: ' + e.message);
  }
}

// ── MERCHANT OVERVIEW (merchant role) ─────────────────────────────────────────
async function loadMerchantOverview() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const user = getUser();
    const now  = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const to   = now.toISOString().split('T')[0];

    const [stmt, txns] = await Promise.all([
      apiFetch(`/reports/merchant-statement?from=${from}&to=${to}`),
      apiFetch('/transactions?perPage=5'),
    ]);

    const s = stmt?.data;
    const sNGN = (s?.summary_by_currency && s.summary_by_currency.NGN) || s?.summary || {};
    const sUSD = (s?.summary_by_currency && s.summary_by_currency.USD) || { successful_transactions:0, total_collections:0, total_fees_paid:0, net_settled:0 };

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Merchant Dashboard</div>
      <div class="page-desc">${s?.merchant?.businessName||user.firstName} — ${from} to ${to}</div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-gray">₦ Local (NGN)</span></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Collections This Month</div><div class="stat-value">${fmtMajor(sNGN.total_collections||0,'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Fees Paid</div><div class="stat-value">${fmtMajor(sNGN.total_fees_paid||0,'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Net Settled</div><div class="stat-value">${fmtMajor(sNGN.net_settled||0,'NGN')}</div></div>
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${fmtNum(sNGN.successful_transactions||0)}</div></div>
    </div>

    <div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-blue">🌍 International (USD)</span><span style="font-size:12px;color:var(--gray-400)">International card sales — settled in USD</span></div>
    <div class="stats-grid">
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Collections (USD)</div><div class="stat-value">${fmtMajor(sUSD.total_collections||0,'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Fees Paid (USD)</div><div class="stat-value">${fmtMajor(sUSD.total_fees_paid||0,'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Net Settled (USD)</div><div class="stat-value">${fmtMajor(sUSD.net_settled||0,'USD')}</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Intl Transactions</div><div class="stat-value">${fmtNum(sUSD.successful_transactions||0)}</div></div>
    </div>

    <div class="card section-gap">
      <div class="card-header"><div class="card-title">Recent Transactions</div><button class="btn btn-outline btn-sm" onclick="navigate('merch_transactions')">View All</button></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Reference</th><th>Amount</th><th>Fee</th><th>Channel</th><th>Currency</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${(txns?.data?.data||[]).map(t=>`<tr ${t.currency==='USD'?'style="background:#f8fbff"':''}>
              <td class="mono" style="font-size:11px">${t.reference}</td>
              <td style="font-weight:600;white-space:nowrap">${fmtMoney(t.amount, t.currency)}</td>
              <td>${fmtMoney(t.fees?.merchant_fee||0, t.currency)}</td>
              <td><span class="tag">${t.channel}${t.currency==='USD'?' · Intl':''}</span></td>
              <td>${ccyChip(t.currency)}</td>
              <td>${statusBadge(t.status)}</td>
              <td style="font-size:12px">${new Date(t.created_at).toLocaleDateString('en-NG')}</td>
            </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray-400)">No transactions yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
    renderMyApplicationBanner();   // surface review status / Activate prompt at the top
  } catch(e) {
    el.innerHTML = errorBox('Failed to load merchant data: ' + e.message);
  }
}

// ── MY APPLICATION status banner (merchant) ─────────────────────────────────────
// Surfaces the onboarding lifecycle to the merchant: under review / rejected (with
// the reviewer's checklist + an Edit & Resubmit button) / approved (Activate). Once
// the account is ACTIVE there is nothing to show.
async function renderMyApplicationBanner() {
  const host = document.getElementById('main-content');
  if (!host) return;
  let app, m;
  try {
    const [aRes, mRes] = await Promise.all([ apiFetch('/onboarding/my-application'), apiFetch('/merchants/me') ]);
    app = aRes && aRes.data;
    m   = mRes && mRes.data;
  } catch (e) { return; }
  const kyc = (m && m.kycStatus) || '';
  if (kyc === 'ACTIVE') return;                 // already live — nothing to surface

  let html = '';
  if (kyc === 'KYC_APPROVED') {
    window._activateMerchant = m;
    html =
      '<div class="card" style="border:1px solid #bbf7d0;background:#f0fdf4;margin-bottom:16px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
        '<div><div style="font-weight:700;color:#166534;font-size:15px">🎉 Your application is approved</div>' +
        '<div style="font-size:13px;color:#166534;margin-top:4px">One step left — activate your account to go live. You\'ll accept the go-live terms and confirm your settlement account, then your live keys start working.</div></div>' +
        '<button class="btn btn-primary" onclick="openActivateModal()">Activate Account</button>' +
      '</div></div>';
  } else if (app && app.status === 'rejected') {
    const items = (app.missingItems || []).map(function (it) {
      return '<li>' + _escA(it.label || it.key) + (it.type === 'doc' ? ' <em>(document)</em>' : '') + '</li>';
    }).join('');
    html =
      '<div class="card" style="border:1px solid #f3c2c2;background:#fff4f4;margin-bottom:16px">' +
        '<div style="font-weight:700;color:#7a2222;font-size:15px">Your application needs corrections</div>' +
        (app.reviewNotes ? '<div style="font-size:13px;color:#7a2222;margin-top:6px"><strong>Reviewer notes:</strong> ' + _escA(app.reviewNotes) + '</div>' : '') +
        (items ? '<div style="font-size:13px;color:#7a2222;margin-top:6px"><strong>Please provide / fix:</strong><ul style="margin:6px 0 0 18px">' + items + '</ul></div>' : '') +
        '<div style="margin-top:10px"><button class="btn btn-primary" onclick="window.location.href=\'/onboarding.html?edit=1\'">Edit &amp; Resubmit Application</button></div>' +
      '</div>';
  } else if (app && (app.status === 'pending' || app.status === 'under_review')) {
    html =
      '<div class="card" style="border:1px solid #bfdbfe;background:#f8fbff;margin-bottom:16px">' +
        '<div style="font-weight:700;color:#1e40af;font-size:15px">Your application is under review</div>' +
        '<div style="font-size:13px;color:#1e40af;margin-top:4px">Our compliance team is reviewing your application — we\'ll email you when there\'s an update. Meanwhile your <strong>test/sandbox</strong> keys work for integration.</div>' +
      '</div>';
  } else { return; }

  const div = document.createElement('div');
  div.id = 'my-app-banner';
  div.innerHTML = html;
  host.insertBefore(div, host.firstChild);
}

// Activate modal: accept go-live terms + confirm the (already captured) settlement
// account, then POST /merchants/me/activate to go live.
function openActivateModal() {
  const m = window._activateMerchant || {};
  const hasSettlement = m.settlementBank && m.settlementAccount && m.settlementAccountName;
  const settleHtml = hasSettlement
    ? '<div class="rev-row"><span class="rev-label">Account name</span><span class="rev-value">' + _escA(m.settlementAccountName) + '</span></div>' +
      '<div class="rev-row"><span class="rev-label">Account number</span><span class="rev-value">' + _escA(m.settlementAccount) + '</span></div>' +
      '<div class="rev-row"><span class="rev-label">Bank</span><span class="rev-value">' + _escA(m.settlementBank) + '</span></div>'
    : '<div class="info-box" style="background:#fff4f4;border-color:#f3c2c2;color:#7a2222;font-size:12px">No settlement account is on file. Please add it (Business Profile → Settlement) before activating — we cannot pay settlements without it.</div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Activate your account</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="padding:4px 2px">' +
      '<p style="font-size:13px;color:var(--gray-600)">Activating makes your account live — your <strong>live</strong> API keys will start working and you can accept real payments.</p>' +
      '<div class="card" style="margin:10px 0"><div class="card-title" style="font-size:13px;margin-bottom:6px">Settlement account (where your money is paid)</div>' + settleHtml + '</div>' +
      '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:10px 0;cursor:pointer">' +
        '<input type="checkbox" id="act-terms" style="margin-top:3px">' +
        '<span>I confirm the settlement account above is correct and I accept the Paylode <a href="/terms.html" target="_blank">go-live terms of service</a>.</span></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">' +
        '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
        (hasSettlement ? '<button class="btn btn-primary" id="act-btn" onclick="activateMyAccount()">Activate &amp; Go Live</button>' : '') +
      '</div>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function activateMyAccount() {
  if (!document.getElementById('act-terms').checked) { alert('Please confirm your settlement account and accept the go-live terms.'); return; }
  const btn = document.getElementById('act-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Activating...'; }
  const res = await apiFetch('/merchants/me/activate', { method: 'POST', body: JSON.stringify({ accept_terms: true }) });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    try { const u = getUser(); if (u.merchant) { u.merchant.kycStatus = 'ACTIVE'; u.merchant.isActive = true; sessionStorage.setItem('paylode_user', JSON.stringify(u)); } } catch (e) {}
    alert('Your account is now live! Your live (sk_live / pk_live) keys are active.');
    loadMerchantOverview();
  } else {
    if (btn) { btn.disabled = false; btn.textContent = 'Activate & Go Live'; }
    alert('Activation failed: ' + ((res && res.message) || 'please try again'));
  }
}

// ── AGGREGATOR OVERVIEW ────────────────────────────────────────────────────────
async function loadAggOverview() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const [merchants, revenue] = await Promise.all([
      apiFetch('/aggregators/my/merchants'),
      apiFetch('/aggregators/my/revenue'),
    ]);

    const myMerchants = merchants?.data || [];
    const rev = revenue?.data || {};
    const myRevenue = Array.isArray(rev) ? rev : (rev.data || []);
    const latestMonth = myRevenue[0];
    const mtdBy = (rev.share_mtd_by_currency) || { NGN:{agg_share:0,txn_count:0}, USD:{agg_share:0,txn_count:0} };

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Aggregator Dashboard</div>
      <div class="page-desc">${myMerchants.length} merchants under your portfolio</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Active Merchants</div><div class="stat-value">${myMerchants.filter(m=>m.isActive).length}</div></div>
      <div class="stat-card"><div class="stat-label">Pending KYC</div><div class="stat-value">${myMerchants.filter(m=>m.kycStatus==='KYC_IN_REVIEW').length}</div></div>
      <div class="stat-card"><div class="stat-label">Payout Status</div><div class="stat-value" style="font-size:16px">${latestMonth?.status||'—'}</div></div>
      <div class="stat-card"><div class="stat-label">Total Merchants</div><div class="stat-value">${fmtNum(myMerchants.length)}</div></div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-gray">₦ Local (NGN)</span><span style="font-size:12px;color:var(--gray-400)">Your revenue share this month — local transactions</span></div>
    <div class="stats-grid" style="grid-template-columns:1fr 1fr">
      <div class="stat-card"><div class="stat-label">Revenue Share (MTD)</div><div class="stat-value text-lime">${fmtMajor(mtdBy.NGN?.agg_share||0,'NGN')}</div><div class="stat-sub">${fmtNum(mtdBy.NGN?.txn_count||0)} transactions</div></div>
      <div class="stat-card"><div class="stat-label">Merchant Fees Generated</div><div class="stat-value">${fmtMajor(mtdBy.NGN?.merchant_fees||0,'NGN')}</div></div>
    </div>

    <div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-blue">🌍 International (USD)</span><span style="font-size:12px;color:var(--gray-400)">Your share from international card transactions — settled in USD</span></div>
    <div class="stats-grid" style="grid-template-columns:1fr 1fr">
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Revenue Share (USD, MTD)</div><div class="stat-value" style="color:#1e40af">${fmtMajor(mtdBy.USD?.agg_share||0,'USD')}</div><div class="stat-sub">${fmtNum(mtdBy.USD?.txn_count||0)} intl transactions</div></div>
      <div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Merchant Fees Generated (USD)</div><div class="stat-value">${fmtMajor(mtdBy.USD?.merchant_fees||0,'USD')}</div></div>
    </div>

    <div class="card section-gap">
      <div class="card-header"><div class="card-title">My Merchants</div><button class="btn btn-outline btn-sm" onclick="navigate('agg_merchants')">View All</button></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Merchant</th><th>Category</th><th>KYC Tier</th><th>Rate</th><th>Status</th></tr></thead>
          <tbody>
            ${myMerchants.slice(0,5).map(m=>`<tr>
              <td style="font-weight:500">${m.businessName}</td>
              <td>${m.category}</td>
              <td>${m.kycTier?'Tier '+m.kycTier:'—'}</td>
              <td>${m.processingRate?(Number(m.processingRate)*100).toFixed(1)+'%':'—'}</td>
              <td>${statusBadge(m.kycStatus)}</td>
            </tr>`).join('')||'<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--gray-400)">No merchants yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load aggregator data: ' + e.message);
  }
}

// ── TAB SWITCHER ──────────────────────────────────────────────────────────────
function switchTab(btn, showId, hideId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(showId).style.display = 'block';
  document.getElementById(hideId).style.display = 'none';
}

// ── KYC ACTIONS ───────────────────────────────────────────────────────────────
async function approveKyc(id) {
  if (!confirm('Approve this KYC application? This will activate the merchant account.')) return;
  const notes = prompt('Add review notes (optional):') || '';
  const res = await apiFetch(`/kyc/${id}/approve`, { method: 'POST', body: JSON.stringify({ notes }) });
  if (res?.status) {
    alert('KYC approved! Merchant account activated and API keys sent.');
    loadCompliance();
  } else {
    alert('Error: ' + (res?.message || 'Could not approve'));
  }
}

async function rejectKyc(id) {
  const code  = prompt('Rejection code (e.g. BVN_MISMATCH, CAC_INVALID, PEP_FLAG):');
  if (!code) return;
  const notes = prompt('Explain the reason to the merchant:');
  if (!notes) return;
  const res = await apiFetch(`/kyc/${id}/reject`, { method: 'POST', body: JSON.stringify({ rejection_code: code, notes }) });
  if (res?.status) {
    alert('KYC rejected. Merchant has been notified by email.');
    loadCompliance();
  } else {
    alert('Error: ' + (res?.message || 'Could not reject'));
  }
}

// ── ADDRESS VERIFICATION ──────────────────────────────────────────────────────
function showAddrVerification(submissionId, currentStatus, reportUrl) {
  var addrBadge = currentStatus === 'passed' ? '<span class="badge badge-green">&#10003; Verified</span>' :
                  currentStatus === 'failed' ? '<span class="badge badge-red">&#10007; Failed</span>'   :
                                               '<span class="badge badge-amber">Pending</span>';
  var reportLink = reportUrl
    ? '<div class="rev-row"><span class="rev-label">Uploaded Report</span>' +
        '<span class="rev-value"><a href="' + reportUrl + '" target="_blank" style="color:var(--navy);font-size:13px">View Report &#8594;</a></span></div>'
    : '<div class="rev-row"><span class="rev-label">Report</span><span class="rev-value" style="color:var(--gray-400)">Not uploaded yet</span></div>';

  var actionBtns = currentStatus !== 'passed'
    ? '<div class="flex" style="gap:8px">' +
        '<button class="btn btn-outline" onclick="submitAddrCheck(\'' + submissionId + '\',\'reject\')">Reject Address</button>' +
        '<button class="btn btn-lime"    onclick="submitAddrCheck(\'' + submissionId + '\',\'approve\')">&#10003; Approve Address</button>' +
      '</div>'
    : '<div class="badge badge-green" style="font-size:13px;padding:8px 16px">Address already verified</div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">Address Verification</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    '<div class="rev-row"><span class="rev-label">Current Status</span><span class="rev-value">' + addrBadge + '</span></div>' +
    reportLink +
    '<div class="divider"></div>' +
    '<div class="form-group"><label class="form-label">Upload Field Officer Report</label>' +
      '<input type="file" id="addr-file-input" accept=".pdf,.jpg,.jpeg,.png" class="form-input">' +
      '<div class="form-hint">PDF, JPG or PNG · max 10 MB · Physical address inspection report</div>' +
    '</div>' +
    '<div id="addr-alert"></div>' +
    '<div class="form-group" id="addr-reject-reason-wrap" style="display:none">' +
      '<label class="form-label">Rejection Reason <span style="color:var(--red)">*</span></label>' +
      '<textarea class="form-input" id="addr-reject-reason" rows="3" placeholder="Explain why the address failed verification (e.g. address does not exist, building demolished, PO Box not acceptable)..."></textarea>' +
    '</div>' +
    '<div class="flex-between" style="margin-top:4px">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Close</button>' +
      actionBtns +
    '</div>';

  document.getElementById('modal').style.display = 'flex';

  // Pre-wire reject button to show reason field
  var rejectBtn = document.querySelector('[onclick*="submitAddrCheck"][onclick*="reject"]');
  if (rejectBtn) {
    rejectBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      e.preventDefault();
      document.getElementById('addr-reject-reason-wrap').style.display = 'block';
      rejectBtn.onclick = null;
      rejectBtn.addEventListener('click', function() { submitAddrCheck(submissionId, 'reject'); });
    }, { once: true });
  }
}

async function submitAddrCheck(submissionId, action) {
  var alertEl = document.getElementById('addr-alert');
  var file    = document.getElementById('addr-file-input') ? document.getElementById('addr-file-input').files[0] : null;
  var reportUrl = null;

  // Upload report first if a file was selected
  if (file) {
    alertEl.innerHTML = '<div class="info-box" style="font-size:12px;margin-bottom:8px">Uploading report...</div>';
    var formData = new FormData();
    formData.append('report', file);
    try {
      var uploadRes = await fetch('/api/v1/kyc/' + submissionId + '/address-check/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() },
        body:    formData,
      });
      var uploadData = await uploadRes.json();
      if (uploadData.status) {
        reportUrl = uploadData.data.report_url;
        alertEl.innerHTML = '<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#15803d;margin-bottom:8px">&#10003; Report uploaded successfully</div>';
      } else {
        alertEl.innerHTML = '<div class="warn-box" style="font-size:12px;margin-bottom:8px">' + (uploadData.message||'Upload failed') + '</div>';
        return;
      }
    } catch(e) {
      alertEl.innerHTML = '<div class="warn-box" style="font-size:12px;margin-bottom:8px">Upload error: ' + e.message + '</div>';
      return;
    }
  }

  // Validate rejection reason
  var body = {};
  if (reportUrl) body.report_url = reportUrl;
  if (action === 'reject') {
    var reason = document.getElementById('addr-reject-reason') ? document.getElementById('addr-reject-reason').value.trim() : '';
    if (!reason) {
      alertEl.innerHTML = '<div class="warn-box" style="font-size:12px;margin-bottom:8px">Please enter a rejection reason.</div>';
      document.getElementById('addr-reject-reason-wrap').style.display = 'block';
      return;
    }
    body.notes = reason;
  }

  var res = await apiFetch('/kyc/' + submissionId + '/address-check/' + action, {
    method: 'PUT',
    body:   JSON.stringify(body),
  });

  if (res && res.status) {
    alert('Address verification ' + (action === 'approve' ? 'approved ✓' : 'rejected') + ' successfully.');
    document.getElementById('modal').style.display = 'none';
    loadCompliance();
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="font-size:12px;margin-bottom:8px">' + ((res && res.message)||'Action failed') + '</div>';
  }
}

// ── SETTLEMENT BATCH ──────────────────────────────────────────────────────────
async function runSettlement() {
  // Default to yesterday, but let the SA pick any date (so a day that actually has
  // successful transactions can be settled — then each PENDING NGN row gets a Fire button).
  var def = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  var d = prompt('Run settlement batch for which date? (YYYY-MM-DD)\nCreates settlement records from that day\'s successful live transactions.', def);
  if (!d) return;
  const res = await apiFetch('/settlements/process', { method: 'POST', body: JSON.stringify({ date: d }) });
  if (res?.status) {
    alert('Settlement complete for ' + d + ': ' + res.data.processed + ' batch(es) created.' + (res.data.processed === 0 ? '\n(No successful transactions on that date.)' : ''));
    loadSettlements();
  } else {
    alert('Error: ' + (res?.message || 'Settlement failed'));
  }
}

// ── MARK SETTLEMENT PAID ──────────────────────────────────────────────────────
async function markSettlementPaid(id, merchantName, amountDue) {
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">Record Payment — ' + merchantName + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    '<div class="rev-row"><span class="rev-label">Amount Due</span><span class="rev-value" style="font-weight:700">&#8358;' + (amountDue||0).toLocaleString(undefined,{minimumFractionDigits:2}) + '</span></div>' +
    '<div class="divider"></div>' +
    '<div class="form-group"><label class="form-label">Amount Paid (&#8358;) <span style="color:var(--red)">*</span></label>' +
      '<input class="form-input" id="sp-amount" type="number" step="0.01" placeholder="Enter amount paid" value="' + (amountDue||'') + '"></div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Payment Date</label>' +
        '<input class="form-input" type="date" id="sp-date" value="' + new Date().toISOString().split('T')[0] + '"></div>' +
      '<div class="form-group"><label class="form-label">Payment Reference / Notes</label>' +
        '<input class="form-input" id="sp-notes" placeholder="Bank transfer ref, NIP ref etc."></div>' +
    '</div>' +
    '<div class="flex-between" style="margin-top:8px">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" onclick="submitSettlementPaid(\'' + id + '\')">Confirm Payment</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function submitSettlementPaid(id) {
  var amount = parseFloat(document.getElementById('sp-amount').value);
  var date   = document.getElementById('sp-date').value;
  var notes  = document.getElementById('sp-notes').value.trim();
  if (!amount || amount <= 0) { alert('Please enter the amount paid'); return; }
  var res = await apiFetch('/settlements/' + id + '/mark-paid', {
    method: 'PUT',
    body:   JSON.stringify({ amount_paid: amount, paid_date: date, payment_notes: notes }),
  });
  if (res && res.status) {
    var d = res.data;
    alert('Payment recorded.\nDue: ₦' + (d.amount_due||0).toLocaleString() +
          '\nPaid: ₦' + (d.amount_paid||0).toLocaleString() +
          '\nOutstanding: ₦' + (d.outstanding||0).toLocaleString() +
          '\nStatus: ' + (d.status||''));
    document.getElementById('modal').style.display = 'none';
    loadSettlements();
  } else {
    alert('Error: ' + ((res && res.message) || 'Payment recording failed'));
  }
}

// ── FIRE SETTLEMENT (auto payout to the merchant's settlement bank) ────────────
// SA (or an SA-granted admin) releases a settlement's NET to the merchant's bank
// via a chosen payout rail — now, or scheduled. Shows the per-channel breakdown
// (+ margin, if SA) so the SA sees what they're paying before firing.
async function fireSettlementModal(id, ref, net, ccy) {
  var m = document.getElementById('modal'); m.style.display = 'flex';
  var inner = document.getElementById('modal-inner');
  var head = '<div class="modal-header"><div class="modal-title">Fire settlement ' + (ref||'') + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>';
  inner.innerHTML = head + '<div style="padding:16px;color:var(--gray-500)">Loading…</div>';
  if (ccy && ccy !== 'NGN') {
    inner.innerHTML = head + '<div class="warn-box">Only NGN settlements can be fired to a Nigerian bank rail.</div>' +
      '<div class="flex-between" style="margin-top:8px"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Close</button></div>';
    return;
  }
  var bres = null, rres = null;
  try { bres = await apiFetch('/settlements/' + id + '/breakdown'); } catch (e) {}
  try { rres = await apiFetch('/payouts/admin/payout-rails'); } catch (e) {}
  var chans = (bres && bres.data && bres.data.channels) ? bres.data.channels : [];
  var hasMargin = chans.length && chans[0].margin != null;
  var money = function(k){ return '₦' + (Number(k||0)/100).toLocaleString(undefined,{minimumFractionDigits:2}); };
  var brk = chans.length
    ? '<table style="width:100%;font-size:12px;margin:6px 0"><tr><th style="text-align:left">Channel</th><th style="text-align:center">Txns</th><th style="text-align:right">Net</th>' + (hasMargin?'<th style="text-align:right">Margin</th>':'') + '</tr>' +
      chans.map(function(c){ return '<tr><td>' + c.channel + '</td><td style="text-align:center">' + c.txn_count + '</td><td style="text-align:right" class="mono">' + money(c.net) + '</td>' + (hasMargin?'<td style="text-align:right" class="mono text-lime">' + money(c.margin) + '</td>':'') + '</tr>'; }).join('') + '</table>'
    : '<div class="form-hint">No per-channel data for this period.</div>';
  var rails = (rres && rres.data ? rres.data : []).filter(function(r){ return String(r.status).toUpperCase() === 'LIVE' && /palmpay/i.test(r.name||''); });
  var railOpts = rails.map(function(r){ return '<option value="' + r.id + '">' + r.name + '</option>'; }).join('');
  inner.innerHTML = head +
    '<div class="rev-row"><span class="rev-label">Net to pay</span><span class="rev-value" style="font-weight:700">' + money((net||0)*100) + '</span></div>' +
    brk +
    (rails.length
      ? '<div class="form-group"><label class="form-label">Payout rail <span style="color:var(--red)">*</span></label><select class="form-input" id="fire-rail">' + railOpts + '</select></div>'
      : '<div class="warn-box">No LIVE PalmPay payout rail available — cannot fire.</div>') +
    '<div class="form-group"><label class="form-label">Schedule (optional — blank = fire now)</label><input class="form-input" type="datetime-local" id="fire-when"></div>' +
    '<div class="warn-box" style="font-size:12px">This releases <strong>real money</strong> to the merchant\'s settlement bank via the chosen rail.</div>' +
    '<div class="flex-between" style="margin-top:8px"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    (rails.length ? '<button class="btn btn-primary" onclick="submitFireSettlement(\'' + id + '\')">Fire settlement</button>' : '') + '</div>';
}

async function submitFireSettlement(id) {
  var railEl = document.getElementById('fire-rail');
  if (!railEl || !railEl.value) { alert('Please select a payout rail'); return; }
  var when = document.getElementById('fire-when').value;
  var body = { rail_id: railEl.value };
  if (when) body.scheduled_at = new Date(when).toISOString();
  if (!confirm(when ? 'Schedule this settlement payout?' : 'Fire this settlement now? Real money will be sent to the merchant.')) return;
  var res = await apiFetch('/settlements/' + id + '/fire', { method: 'POST', body: JSON.stringify(body) });
  alert((res && res.message) ? res.message : (res && res.status ? 'Done' : 'Failed'));
  if (res && res.status) { document.getElementById('modal').style.display = 'none'; loadSettlements(); }
}

async function runSandboxSettlement() {
  var today = new Date().toISOString().split('T')[0];
  var day = prompt('Run SANDBOX settlement batch for which date? (YYYY-MM-DD)\nProcesses isSandbox=true transactions only.', today);
  if (!day) return;
  var res = await apiFetch('/settlements/process', {
    method: 'POST',
    body:   JSON.stringify({ sandbox: true, date: day }),
  });
  if (res && res.status) {
    var d = res.data;
    var summary = 'Settlement batch complete!\n' + d.processed + ' batches created\n\n';
    if (d.results && d.results.length) {
      d.results.forEach(function(r) {
        summary += r.merchant + ':\n';
        summary += '  Transactions: ' + r.txn_count + '\n';
        summary += '  Gross: ₦' + (r.gross_naira||0).toLocaleString() + '\n';
        summary += '  Fee Revenue: ₦' + (r.fee_revenue||0).toLocaleString() + '\n';
        summary += '  Rail Cost: ₦' + (r.rail_cost||0).toLocaleString() + '\n';
        summary += '  Agg Share: ₦' + (r.agg_share||0).toLocaleString() + '\n';
        summary += '  Paylode Margin: ₦' + (r.paylode_margin||0).toLocaleString() + '\n';
        summary += '  Merchant Gets: ₦' + (r.net_to_merchant||0).toLocaleString() + '\n';
        summary += '  Fee Paid By: ' + r.fee_paid_by + '\n\n';
      });
    } else {
      summary += 'No sandbox transactions found for today.';
    }
    alert(summary);
    loadSettlements();
  } else {
    alert('Error: ' + ((res && res.message) || 'Batch failed'));
  }
}

// ── AGGREGATOR SPLIT EDIT ─────────────────────────────────────────────────────
// Full aggregator edit (company, RC, settlement, split).
function editAggregator(id) {
  if (!userHasPerm('edit_aggregators')) { alert('You have view-only access to aggregators.'); return; }
  var a = (window._aggData || []).find(function(x){ return x.id === id; });
  if (!a) { alert('Aggregator not found — reload the page.'); return; }
  var esc = function(s){ return String(s||'').replace(/"/g,'&quot;'); };
  showModal(
    '<div class="modal-header"><div class="modal-title">Edit Aggregator</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Company name</label><input class="form-input" id="ea-name" value="' + esc(a.companyName) + '"></div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">RC number</label><input class="form-input" id="ea-rc" value="' + esc(a.rcNumber) + '"></div>' +
      '<div class="form-group"><label class="form-label">Revenue split %</label><input class="form-input" id="ea-split" type="number" min="0" max="100" value="' + (Number(a.revenueSplitPct)*100).toFixed(0) + '"></div>' +
    '</div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Settlement bank</label><input class="form-input" id="ea-bank" value="' + esc(a.settlementBank) + '"></div>' +
      '<div class="form-group"><label class="form-label">Settlement account</label><input class="form-input" id="ea-acct" value="' + esc(a.settlementAccount) + '" maxlength="10"></div>' +
    '</div>' +
    '<div class="flex-between" style="margin-top:8px">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" id="ea-btn" onclick="saveAggregatorEdit(\'' + id + '\')">Save Changes</button></div>' +
    '<div id="ea-msg" style="margin-top:8px"></div>');
}
async function saveAggregatorEdit(id) {
  var splitPct = parseFloat(document.getElementById('ea-split').value);
  var body = {
    company_name:       document.getElementById('ea-name').value.trim(),
    rc_number:          document.getElementById('ea-rc').value.trim(),
    settlement_bank:    document.getElementById('ea-bank').value.trim(),
    settlement_account: document.getElementById('ea-acct').value.trim(),
  };
  if (!isNaN(splitPct)) body.revenue_split_pct = splitPct / 100;
  var btn = document.getElementById('ea-btn'); btn.disabled = true; btn.textContent = 'Saving...';
  var res = await apiFetch('/aggregators/' + id, { method: 'PUT', body: JSON.stringify(body) });
  if (res && res.status) { document.getElementById('modal').style.display = 'none'; loadAggregators(); }
  else { document.getElementById('ea-msg').innerHTML = '<div class="warn-box" style="font-size:12px">' + ((res&&res.message)||'Failed') + '</div>'; btn.disabled=false; btn.textContent='Save Changes'; }
}

async function editSplit(id, currentSplit) {
  if (!userHasPerm('edit_aggregators')) { alert('You have view-only access to aggregators.'); return; }
  const newSplit = prompt(`Current split: ${(Number(currentSplit)*100).toFixed(0)}%\nEnter new split percentage (e.g. 30 for 30%):`);
  if (!newSplit) return;
  const rate = parseFloat(newSplit) / 100;
  if (isNaN(rate) || rate < 0 || rate > 1) { alert('Invalid percentage'); return; }
  const res = await apiFetch(`/aggregators/${id}/split`, { method: 'PUT', body: JSON.stringify({ revenue_split_pct: rate }) });
  if (res?.status) {
    alert('Revenue split updated successfully');
    loadAggregators();
  } else {
    alert('Error: ' + (res?.message || 'Update failed'));
  }
}

// ── SETTLEMENT BANK VERIFICATION QUEUE ───────────────────────────────────────
async function loadSettlementQueue() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var filter = window._settleFilter || 'pending_manual';
    var res = await apiFetch('/merchants/settlement/pending?status=' + filter);
    var merchants = (res && res.data) ? res.data : [];

    var statusColors = {
      unverified:      'badge-gray',
      pending_manual:  'badge-amber',
      auto_verified:   'badge-green',
      manual_approved: 'badge-green',
      verified:        'badge-green',
      rejected:        'badge-red',
    };
    var statusLabels = {
      unverified:      'Not Submitted',
      pending_manual:  'Awaiting Review',
      auto_verified:   'Auto Verified',
      manual_approved: 'Approved',
      verified:        'Verified',
      rejected:        'Rejected',
    };

    var filterBtns = [
      ['pending_manual','Awaiting Review'],['verified','Verified'],['rejected','Rejected'],['all','All'],
    ].map(function(f) {
      return '<button class="btn ' + (filter === f[0] ? 'btn-primary' : 'btn-outline') + ' btn-sm" ' +
        'onclick="window._settleFilter=\'' + f[0] + '\';loadSettlementQueue()">' + f[1] + '</button>';
    }).join('&nbsp;');

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div><div class="page-title">Settlement Bank Verification</div>' +
          '<div class="page-desc">Verify merchant settlement account details before enabling payouts</div></div>' +
        '<div class="flex" style="gap:6px">' + filterBtns + '</div>' +
      '</div>' +
      '<div class="info-box" style="margin-bottom:16px;font-size:12px">' +
        '<strong>How verification works:</strong> When a merchant\'s bank details are saved, Paylode performs a name enquiry via the bank partner. ' +
        'If the returned name matches the submitted account name, it is auto-verified. ' +
        'If there is a mismatch, or the bank partner is not yet live, the account lands here for manual review. ' +
        'Approve only after physically confirming the account details are correct.' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Merchant</th><th>Submitted Account Name</th><th>Bank</th><th>Account No.</th><th>Bank Returned Name</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>' +
        '<tbody>' +
        (merchants.length ? merchants.map(function(m) {
          var st = m.settleVerifyStatus || 'unverified';
          var badge = '<span class="badge ' + (statusColors[st]||'badge-gray') + '">' + (statusLabels[st]||st) + '</span>';
          var enquiryName = m.settleEnquiryName
            ? '<span style="color:' + (m.settleEnquiryName === m.settlementAccountName ? 'var(--green)' : 'var(--red)') + ';font-weight:500">' + m.settleEnquiryName + '</span>'
            : '<span style="color:var(--gray-400)">—</span>';
          var actions = (st === 'pending_manual')
            ? '<button class="btn btn-lime btn-sm" onclick="approveSettlement(\'' + m.id + '\',\'' + m.businessName.replace(/'/g,'') + '\')">Approve</button>&nbsp;' +
              '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="rejectSettlement(\'' + m.id + '\',\'' + m.businessName.replace(/'/g,'') + '\')">Reject</button>'
            : '<span style="font-size:12px;color:var(--gray-400)">' + (m.settleVerifiedAt ? new Date(m.settleVerifiedAt).toLocaleDateString('en-NG') : '—') + '</span>';
          // Show the REQUESTED (pending) account when present, with the current live
          // account underneath so the reviewer sees exactly what is changing (#5).
          var pend = (st === 'pending_manual' && m.pendingSettlementAccount);
          var shownName = pend ? m.pendingSettlementAccountName : m.settlementAccountName;
          var shownBank = pend ? m.pendingSettlementBank : m.settlementBank;
          var shownAcct = pend ? m.pendingSettlementAccount : m.settlementAccount;
          var curHint = pend
            ? '<div style="font-size:10px;color:var(--gray-400)">current: ' + (m.settlementAccount||'none') + ' · ' + (m.settlementBank||'—') + '</div>'
            : '';
          return '<tr>' +
            '<td><div style="font-weight:500;font-size:13px">' + m.businessName + '</div>' +
              '<div class="mono" style="font-size:10px;color:var(--gray-400)">' + (m.merchantCode||'') + '</div></td>' +
            '<td style="font-size:13px">' + (shownName||'<span style="color:var(--gray-400)">—</span>') + '</td>' +
            '<td style="font-size:12px">' + (shownBank||'—') + '</td>' +
            '<td class="mono" style="font-size:12px">' + (shownAcct||'—') + curHint + '</td>' +
            '<td>' + enquiryName + '</td>' +
            '<td>' + badge + '</td>' +
            '<td style="font-size:11px;color:var(--gray-500);max-width:180px">' + (m.settleVerifyNotes||'—') + '</td>' +
            '<td style="white-space:nowrap">' + actions + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--gray-400)">No accounts in this status</td></tr>') +
        '</tbody>' +
      '</table></div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load settlement queue: ' + e.message);
  }
}

async function approveSettlement(id, name) {
  var notes = prompt('Approval notes for ' + name + ' (optional — e.g. "Verified via bank statement"):') || 'Manually verified by administrator';
  if (notes === null) return;
  var res = await apiFetch('/merchants/' + id + '/settlement/approve', {
    method: 'PUT',
    body:   JSON.stringify({ notes: notes }),
  });
  if (res && res.status) {
    alert(name + ' settlement account approved.');
    loadSettlementQueue();
  } else {
    alert('Error: ' + ((res && res.message) || 'Approval failed'));
  }
}

async function rejectSettlement(id, name) {
  var reason = prompt('Reason for rejecting settlement account for ' + name + ' (required):');
  if (!reason) return;
  var res = await apiFetch('/merchants/' + id + '/settlement/reject', {
    method: 'PUT',
    body:   JSON.stringify({ notes: reason }),
  });
  if (res && res.status) {
    alert(name + ' settlement account rejected. Merchant must resubmit correct details.');
    loadSettlementQueue();
  } else {
    alert('Error: ' + ((res && res.message) || 'Rejection failed'));
  }
}

// ── MERCHANT PROFILE ─────────────────────────────────────────────────────────
var _merchProfileData = null;

async function loadMerchProfile() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/merchants/me');
    var m = (res && res.data) ? res.data : null;
    if (!m) {
      var u = getUser();
      m = { businessName: u.businessName || u.firstName || '—', category: u.category || '—',
            rcNumber: u.rcNumber || '—', businessPhone: u.phone || '—', address: u.address || '—',
            settlementBank: u.settlementBank || '—', kycStatus: u.kycStatus || '—',
            kycTier: u.kycTier || '—', processingRate: u.processingRate || null,
            user: { email: u.email || '—' } };
    }
    _merchProfileData = m;
    var rate = m.processingRate ? (Number(m.processingRate)*100).toFixed(1)+'%' : '—';
    var row = function(label, val) {
      return '<div class="rev-row"><span class="rev-label">' + label + '</span><span class="rev-value" style="font-size:13px">' + val + '</span></div>';
    };
    var vst = m.settleVerifyStatus || 'unverified';
    var vstColors = { unverified:'badge-gray', pending_manual:'badge-amber', auto_verified:'badge-green', manual_approved:'badge-green', rejected:'badge-red' };
    var vstLabels = { unverified:'Not Submitted', pending_manual:'Awaiting Review', auto_verified:'Verified', manual_approved:'Verified', rejected:'Rejected — Update Required' };

    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">Business Profile</div>' +
        '<div class="page-desc">Your merchant account details</div></div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="card"><div class="card-header"><div class="card-title">Business Information</div>' +
          '<button class="btn btn-outline btn-sm" onclick="showEditProfileModal()">&#9998; Edit</button></div>' +
          row('Business Name',   m.businessName || '—') +
          row('Category',        m.category || '—') +
          row('RC Number',       m.rcNumber || '—') +
          row('Email',           (m.user && m.user.email) || '—') +
          row('Phone',           m.businessPhone || m.phone || '—') +
          row('Address',         m.address || '—') +
          row('Website',         m.website ? '<a href="' + m.website + '" target="_blank" style="color:var(--navy)">' + m.website + '</a>' : '—') +
          row('Processing Rate', rate) +
          row('KYC Tier',        m.kycTier ? 'Tier ' + m.kycTier : '—') +
          row('KYC Status',      statusBadge(m.kycStatus)) +
        '</div>' +
        '<div class="card"><div class="card-header"><div class="card-title">Settlement Account</div>' +
          '<button class="btn btn-outline btn-sm" onclick="showChangeSettlementModal()">&#9998; Change</button></div>' +
          row('Settlement Bank',    m.settlementBank || '—') +
          row('Account Number',     m.settlementAccount ? '<span class="mono">' + m.settlementAccount + '</span>' : '—') +
          row('Account Name',       m.settlementAccountName || '—') +
          row('Verification',       '<span class="badge ' + (vstColors[vst]||'badge-gray') + '">' + (vstLabels[vst]||vst) + '</span>') +
          row('Settlement Cycle',   m.settlementCycle || 'T+1') +
          row('Aggregator',         (m.aggregator && m.aggregator.companyName) || 'Direct') +
          (m.settleVerifyStatus === 'rejected' ? '<div class="warn-box" style="margin-top:12px;font-size:12px"><strong>Account rejected:</strong> ' + (m.settleVerifyNotes||'Contact support for details.') + '</div>' : '') +
        '</div>' +
      '</div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load profile: ' + e.message);
  }
}

function showEditProfileModal() {
  var m = _merchProfileData || {};
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Edit Business Information</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">You can update your contact details. Business name and RC number changes require contacting support.</div>' +
    '<div class="form-group"><label class="form-label">Phone Number</label><input class="form-input" id="ep-phone" value="' + (m.businessPhone||m.phone||'') + '" placeholder="+234 800 000 0000"></div>' +
    '<div class="form-group"><label class="form-label">Business Address</label><input class="form-input" id="ep-address" value="' + (m.address||'') + '" placeholder="Street, City, State"></div>' +
    '<div class="form-group"><label class="form-label">Website</label><input class="form-input" id="ep-website" value="' + (m.website||'') + '" placeholder="https://yourwebsite.com"></div>' +
    '<div id="ep-alert"></div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" id="ep-save-btn" onclick="saveProfileEdits()">Save Changes</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function saveProfileEdits() {
  var phone   = document.getElementById('ep-phone').value.trim();
  var address = document.getElementById('ep-address').value.trim();
  var website = document.getElementById('ep-website').value.trim();
  var alertEl = document.getElementById('ep-alert');
  if (!phone && !address && !website) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Enter at least one field to update</div>'; return; }
  var btn = document.getElementById('ep-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  var body = {};
  if (phone)   body.businessPhone = phone;
  if (address) body.address       = address;
  if (website) body.website       = website;
  var res = await apiFetch('/merchants/me/profile', { method: 'PUT', body: JSON.stringify(body) });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    loadMerchProfile();
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Update failed') + '</div>';
    btn.textContent = 'Save Changes'; btn.disabled = false;
  }
}

function showChangeSettlementModal() {
  var m = _merchProfileData || {};
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Change Settlement Account</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="warn-box" style="margin-bottom:16px;font-size:12px">&#9888; Changing your settlement account will require re-verification before payouts resume. Ensure account details are correct.</div>' +
    '<div class="form-group"><label class="form-label">Bank Name <span style="color:var(--red)">*</span></label><input class="form-input" id="cs-bank" value="' + (m.settlementBank||'') + '" placeholder="e.g. Guaranty Trust Bank"></div>' +
    '<div class="form-group"><label class="form-label">Account Number <span style="color:var(--red)">*</span></label><input class="form-input" id="cs-acct" value="' + (m.settlementAccount||'') + '" placeholder="10 digits" maxlength="10"></div>' +
    '<div class="form-group"><label class="form-label">Account Name <span style="color:var(--red)">*</span></label><input class="form-input" id="cs-name" value="' + (m.settlementAccountName||'') + '" placeholder="As registered with bank"></div>' +
    '<div id="cs-alert"></div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" id="cs-save-btn" onclick="saveSettlementChange()">Submit for Verification</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function saveSettlementChange() {
  var bank = document.getElementById('cs-bank').value.trim();
  var acct = document.getElementById('cs-acct').value.trim();
  var name = document.getElementById('cs-name').value.trim();
  var alertEl = document.getElementById('cs-alert');
  if (!bank || !acct || !name) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">All fields are required</div>'; return; }
  if (!/^\d{10}$/.test(acct)) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Account number must be exactly 10 digits</div>'; return; }
  var btn = document.getElementById('cs-save-btn');
  btn.textContent = 'Submitting...'; btn.disabled = true;
  var res = await apiFetch('/merchants/me/settlement', { method: 'PUT', body: JSON.stringify({ settlementBank: bank, settlementAccount: acct, settlementAccountName: name }) });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    loadMerchProfile();
    alert('Settlement details submitted for verification. Payouts will resume once approved (typically 1 business day).');
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Submission failed') + '</div>';
    btn.textContent = 'Submit for Verification'; btn.disabled = false;
  }
}

// ── MERCHANT API KEYS ─────────────────────────────────────────────────────────
async function loadMerchApiKeys() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/merchants/me/api-keys');
    var keys = (res && res.data) ? res.data : [];

    // "Live keys activate after KYC" guidance (Stripe-style application-time keys).
    var _u = getUser(); var _m = (_u && _u.merchant) || {};
    var kycActive = _m.isActive === true || (_m.kycStatus && String(_m.kycStatus).toUpperCase() === 'ACTIVE');
    var kycNote = kycActive
      ? '<div class="info-box" style="margin-bottom:16px;font-size:12px;background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Your account is KYC-verified — your <strong>live</strong> keys (sk_live / pk_live) are active.</div>'
      : '<div class="info-box" style="margin-bottom:16px;font-size:12px">&#9888; Your <strong>test</strong> keys (sk_test / pk_test) work now for sandbox integration. Your <strong>live</strong> keys activate <strong>automatically once your KYC is approved</strong> — then just switch sk_test → sk_live in your code. No need to contact support.</div>';

    var html = keys.length ? keys.map(function(k) {
      var isSandbox = k.isSandbox || (k.keyPrefix && k.keyPrefix.includes('test'));
      var envBadge = isSandbox ? 'badge-blue' : 'badge-green';
      var envLabel = isSandbox ? 'Test' : 'Live';
      var prefix   = k.keyPrefix || '••••';
      var displayKey = prefix + '••••••••••••••••••••••••';
      return '<div class="rev-row" style="padding:14px 0"><div style="flex:1;min-width:0">' +
        '<div class="flex" style="gap:8px;margin-bottom:6px">' +
          '<span style="font-weight:600;font-size:13px">' + (k.label||'API Key') + '</span>' +
          '<span class="badge ' + envBadge + '">' + envLabel + '</span>' +
        '</div>' +
        '<div class="mono" style="font-size:12px;color:var(--gray-500);word-break:break-all" id="key-display-' + k.id + '">' + displayKey + '</div>' +
        '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">Last used: ' + (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString('en-NG') : 'Never') + ' · Created: ' + new Date(k.createdAt).toLocaleDateString('en-NG') + '</div>' +
      '</div>' +
      '<div class="flex" style="gap:6px;margin-left:16px">' +
        '<button class="btn btn-outline btn-sm" onclick="copyApiKeyPrefix(\'' + k.id + '\',\'' + prefix + '\')">&#128203; Copy</button>' +
        '<button class="btn btn-outline btn-sm" style="color:var(--amber)" onclick="rotateApiKey(\'' + k.id + '\',\'' + prefix + '\',\'' + (k.label||'API Key').replace(/'/g,"\\'") + '\')">&#8635; Rotate</button>' +
      '</div></div>';
    }).join('') : '<div class="info-box" style="font-size:12px">No API keys yet. Test keys are issued automatically when your account is created — refresh, or contact support@paylodeservices.com if they are missing.</div>';

    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">API Keys</div>' +
        '<div class="page-desc">Manage your integration credentials</div></div>' +
        '<button class="btn btn-lime" onclick="showGenerateKeyModal()">+ Generate New Key</button>' +
      '</div>' +
      kycNote +
      '<div class="warn-box" style="margin-bottom:20px">&#9888; Secret keys (sk_) are shown only once. Copy them immediately after generation or rotation.</div>' +
      '<div class="card">' + html + '</div>' +
      '<div id="key-result-area" style="margin-top:16px"></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load API keys: ' + e.message);
  }
}

function copyAdminSignupLink() {
  var url = location.origin + '/onboarding.html?type=merchant';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function(){ alert('Merchant sign-up link copied:\n' + url); })
      .catch(function(){ prompt('Copy this sign-up link:', url); });
  } else { prompt('Copy this sign-up link:', url); }
}

function copyApiKeyPrefix(id, prefix) {
  navigator.clipboard.writeText(prefix + '...(rotate to get full key)').then(function() {
    alert('Key prefix copied. To get the full secret key, use Rotate — it will display the new key once.');
  }).catch(function() {
    var el = document.getElementById('key-display-' + id);
    if (el) { var range = document.createRange(); range.selectNode(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); document.execCommand('copy'); }
    alert('Key prefix copied to clipboard.');
  });
}

async function rotateApiKey(id, prefix, label) {
  if (!confirm('Rotate "' + label + '"?\n\nThe current key will be immediately revoked. Any integrations using it will stop working until updated with the new key.\n\nProceed?')) return;
  var res = await apiFetch('/merchants/me/api-keys/rotate', { method: 'POST', body: JSON.stringify({ prefix, label }) });
  if (res && res.status) {
    var area = document.getElementById('key-result-area');
    if (area) {
      area.innerHTML = '<div style="background:#1a2744;border-radius:10px;padding:20px;color:#fff;margin-top:8px">' +
        '<div style="color:var(--lime);font-weight:700;margin-bottom:8px">&#10003; Key Rotated — Save This Now</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,.6);margin-bottom:8px">This key will NOT be shown again. Copy it immediately.</div>' +
        '<div class="mono" style="background:rgba(255,255,255,.08);padding:12px;border-radius:6px;word-break:break-all;font-size:13px" id="new-key-val">' + res.data.key + '</div>' +
        '<button class="btn btn-lime" style="margin-top:12px" onclick="navigator.clipboard.writeText(document.getElementById(\'new-key-val\').textContent);this.textContent=\'Copied!\';setTimeout(()=>{this.textContent=\'Copy Key\'},2000)">Copy Key</button>' +
      '</div>';
    }
    loadMerchApiKeys();
  } else {
    alert('Error: ' + ((res && res.message) || 'Rotation failed'));
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MERCHANT — PAYMENT LINKS (shareable, no-code checkout links)
// ════════════════════════════════════════════════════════════════════════════
var _plTab = 'links';
async function loadMerchPaymentLinks() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML =
    '<div class="page-header flex-between"><div><div class="page-title">Payment Links & QR Code</div>' +
      '<div class="page-desc">Shareable checkout links and scan-to-pay QR codes — no code required.</div></div>' +
      '<div id="pl-action"></div>' +
    '</div>' +
    '<div class="flex" style="gap:6px;margin-bottom:16px">' +
      '<button id="pl-tab-links" class="btn btn-sm btn-lime" onclick="plSwitchTab(\'links\')">Payment Links</button>' +
      '<button id="pl-tab-qr" class="btn btn-sm btn-outline" onclick="plSwitchTab(\'qr\')">QR Codes</button>' +
    '</div>' +
    '<div id="pl-tab-body">' + loading() + '</div>';
  plSwitchTab(_plTab);
}

function plSwitchTab(tab) {
  _plTab = tab;
  var lb = document.getElementById('pl-tab-links'), qb = document.getElementById('pl-tab-qr');
  if (lb) lb.className = 'btn btn-sm ' + (tab === 'links' ? 'btn-lime' : 'btn-outline');
  if (qb) qb.className = 'btn btn-sm ' + (tab === 'qr' ? 'btn-lime' : 'btn-outline');
  var act = document.getElementById('pl-action');
  if (tab === 'qr') {
    if (act) act.innerHTML = '<button class="btn btn-lime" onclick="plQrShowCreate()">+ New QR Code</button>';
    plRenderQrTab();
  } else {
    if (act) act.innerHTML = '<button class="btn btn-lime" onclick="showCreatePaymentLinkModal()">+ New Payment Link</button>';
    plRenderLinksTab();
  }
}

async function plRenderLinksTab() {
  var el = document.getElementById('pl-tab-body');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res   = await apiFetch('/payment-links');
    var links = (res && res.data) ? res.data : [];
    var _u = getUser(); var _m = (_u && _u.merchant) || {};
    var kycActive = _m.isActive === true || (_m.kycStatus && String(_m.kycStatus).toUpperCase() === 'ACTIVE');
    var note = kycActive ? '' :
      '<div class="warn-box" style="margin-bottom:16px;font-size:12px">&#9888; Your account isn\'t live yet — customers can\'t complete payment on these links until your KYC is approved. You can still create and share them now.</div>';

    var rows = links.length ? links.map(function(l) {
      var amt = (l.amount === null || l.amount === undefined)
        ? '<span style="color:var(--gray-400)">Customer enters</span>' : fmtMoney(l.amount, l.currency);
      var st  = l.status === 'active'
        ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Disabled</span>';
      var url = l.url || (window.location.origin + '/checkout.html?link=' + l.slug);
      var toggleLabel = l.status === 'active' ? 'Disable' : 'Enable';
      var toggleTo    = l.status === 'active' ? 'disabled' : 'active';
      var safeUrl = _escA(url).replace(/'/g, "\\'");
      return '<tr>' +
        '<td><div style="font-weight:600">' + _escA(l.title) + '</div>' +
          (l.description ? '<div style="font-size:11px;color:var(--gray-400)">' + _escA(l.description) + '</div>' : '') +
          (l.recipient_email ? '<div style="font-size:11px;color:var(--gray-500)">To: ' + _escA(l.recipient_email) + '</div>' : '') +
          (l.reusable ? '' : ' <span class="badge badge-blue" style="font-size:10px">one-off</span>') + '</td>' +
        '<td>' + amt + '</td>' +
        '<td>' + st + '</td>' +
        '<td style="text-align:center">' + (l.paid_count || 0) + '</td>' +
        '<td><div class="mono" style="font-size:11px;color:var(--gray-500);word-break:break-all;max-width:240px">' + _escA(url) + '</div></td>' +
        '<td><div class="flex" style="gap:6px;flex-wrap:wrap">' +
          '<button class="btn btn-outline btn-sm" onclick="plCopy(\'' + safeUrl + '\',this)">Copy</button>' +
          '<button class="btn btn-outline btn-sm" onclick="plShowQr(\'' + encodeURIComponent(url) + '\')">QR</button>' +
          '<button class="btn btn-outline btn-sm" onclick="plToggle(\'' + l.id + '\',\'' + toggleTo + '\')">' + toggleLabel + '</button>' +
          '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="plDelete(\'' + l.id + '\')">Delete</button>' +
        '</div></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:30px">No payment links yet. Create one to start collecting payments with a shareable link.</td></tr>';

    el.innerHTML = note +
      '<div class="card"><div class="table-wrap"><table>' +
      '<thead><tr><th>Title</th><th>Amount</th><th>Status</th><th>Paid</th><th>Link</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  } catch (e) {
    el.innerHTML = errorBox('Failed to load payment links: ' + e.message);
  }
}

function showCreatePaymentLinkModal() {
  showModal(
    '<div class="modal-header"><div class="modal-title">New Payment Link</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="padding:4px 2px">' +
      '<div class="form-group"><label class="form-label">Title *</label>' +
        '<input class="form-input" id="pl-f-title" placeholder="e.g. Premium Plan, Donation, Invoice #1024"></div>' +
      '<div class="form-group"><label class="form-label">Description (optional)</label>' +
        '<input class="form-input" id="pl-f-desc" placeholder="Shown to the customer"></div>' +
      '<div class="form-group"><label class="form-label">Customer phone (optional)</label>' +
        '<input class="form-input" id="pl-f-phone" type="tel" placeholder="for WhatsApp/SMS delivery (coming soon)"></div>' +
      '<div class="form-group"><label class="form-label">Amount (₦) — leave blank to let the customer enter it</label>' +
        '<input class="form-input" id="pl-f-amount" type="number" min="1" step="0.01" placeholder="e.g. 5000"></div>' +
      '<div class="form-group"><label style="font-size:13px;display:flex;align-items:center;gap:8px"><input type="checkbox" id="pl-f-vat"> Charge 7.5% VAT — added on top of the amount the customer pays.</label></div>' +
      '<div class="form-group"><label style="font-size:13px;display:flex;align-items:center;gap:8px"><input type="checkbox" id="pl-f-reusable" checked> Reusable (uncheck for a one-time link). Ignored when you add recipients below — those are always one-off.</label></div>' +
      '<div class="form-group"><label class="form-label">Expires (optional)</label>' +
        '<input class="form-input" id="pl-f-expires" type="date"></div>' +
      '<div class="form-group"><label class="form-label">Recipients (optional) — leave blank for a plain shareable link</label>' +
        '<textarea class="form-input" id="pl-f-recipients" rows="3" placeholder="Emails separated by comma or new line. Each gets a UNIQUE link, emailed to them." oninput="plRecipientPreview()"></textarea></div>' +
      '<div class="flex" style="gap:8px;align-items:center;margin:-4px 0 8px;flex-wrap:wrap">' +
        '<input type="file" id="pl-f-xls" accept=".xlsx,.xls,.csv" style="display:none" onchange="plUploadRecipientsXls(this)">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById(\'pl-f-xls\').click()">Upload XLS / CSV</button>' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="plDownloadSampleXls()">Sample file</button>' +
        '<span id="pl-f-recipreview" style="font-size:11px;color:var(--gray-500)"></span>' +
      '</div>' +
      '<div id="pl-f-error" class="warn-box" style="display:none;margin-top:8px"></div>' +
      '<button class="btn btn-lime" style="width:100%;margin-top:8px" onclick="submitCreatePaymentLink()">Create Link</button>' +
    '</div>'
  );
}

// Recipient helpers — single or bulk emails, validated client-side.
function plParseEmails(str) {
  return (str || '').split(/[\s,;]+/).map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean)
    .filter(function(e, i, a){ return a.indexOf(e) === i; });
}
function plEmailOk(e){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function plRecipientPreview() {
  var ta = document.getElementById('pl-f-recipients'); if (!ta) return;
  var list = plParseEmails(ta.value);
  var bad  = list.filter(function(e){ return !plEmailOk(e); });
  var el = document.getElementById('pl-f-recipreview');
  if (el) el.innerHTML = list.length
    ? (list.length - bad.length) + ' valid' + (bad.length ? ', <span style="color:var(--red)">' + bad.length + ' invalid</span>' : '')
    : '';
}
function plUploadRecipientsXls(input) {
  var f = input.files && input.files[0]; if (!f) return;
  var reader = new FileReader();
  reader.onload = function(e){
    try {
      var wb   = XLSX.read(e.target.result, { type:'array' });
      var ws   = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });
      var found = [];
      rows.forEach(function(r){ (r||[]).forEach(function(c){ var s = String(c||'').trim(); if (s.indexOf('@') > 0) found.push(s); }); });
      var ta = document.getElementById('pl-f-recipients');
      ta.value = plParseEmails((ta.value ? ta.value + '\n' : '') + found.join('\n')).join('\n');
      plRecipientPreview();
    } catch (err) { alert('Could not read that file: ' + err.message); }
    input.value = '';
  };
  reader.readAsArrayBuffer(f);
}
function plDownloadSampleXls() {
  // Header only — NO example recipients (so nothing placeholder can be sent by mistake).
  var aoa = [['email']];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Recipients');
  XLSX.writeFile(wb, 'paylode_recipients_sample.xlsx');
}

async function submitCreatePaymentLink() {
  var errEl = document.getElementById('pl-f-error');
  var show  = function(m) { errEl.textContent = m; errEl.style.display = 'block'; };
  errEl.style.display = 'none';
  var title = (document.getElementById('pl-f-title').value || '').trim();
  if (!title) return show('A title is required.');
  var body = { title: title, reusable: document.getElementById('pl-f-reusable').checked,
               charge_vat: document.getElementById('pl-f-vat').checked };
  var desc = (document.getElementById('pl-f-desc').value || '').trim();
  if (desc) body.description = desc;
  var phone = (document.getElementById('pl-f-phone').value || '').trim();
  if (phone) body.customer_phone = phone;
  var amtRaw = (document.getElementById('pl-f-amount').value || '').trim();
  if (amtRaw !== '') {
    var v = parseFloat(amtRaw);
    if (!(v > 0)) return show('Enter a valid amount, or leave it blank for a customer-entered amount.');
    body.amount = Math.round(v * 100); // naira → kobo
  }
  var exp = (document.getElementById('pl-f-expires').value || '').trim();
  if (exp) body.expires_at = exp;

  // Recipient mode: one unique link per email, auto-emailed.
  var recEl = document.getElementById('pl-f-recipients');
  var recips = recEl ? plParseEmails(recEl.value) : [];
  if (recips.length) {
    var bad = recips.filter(function(e){ return !plEmailOk(e); });
    if (bad.length && !confirm(bad.length + ' email(s) look invalid and will be skipped:\n' + bad.slice(0,10).join(', ') + (bad.length>10?' …':'') + '\n\nContinue?')) return;
    body.recipients = recips;
    var bres = await apiFetch('/payment-links/batch', { method: 'POST', body: JSON.stringify(body) });
    if (!bres || !bres.status) return show((bres && bres.message) || 'Could not create the links.');
    document.getElementById('modal').style.display = 'none';
    loadMerchPaymentLinks();
    var d = bres.data || {};
    setTimeout(function() {
      showModal(
        '<div class="modal-header"><div class="modal-title">Payment Requests Sent</div>' +
        '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
        '<div style="padding:6px 2px;font-size:13px">' +
          '<p><strong>' + (d.created||0) + '</strong> unique link(s) created · <strong>' + (d.emailed||0) + '</strong> emailed.</p>' +
          ((d.invalid_emails && d.invalid_emails.length) ? '<p style="color:var(--red)">Skipped ' + d.invalid_emails.length + ' invalid: ' + _escA(d.invalid_emails.slice(0,20).join(', ')) + '</p>' : '') +
          ((d.email_failed && d.email_failed.length) ? '<p style="color:#b45309">Could not email ' + d.email_failed.length + ': ' + _escA(d.email_failed.slice(0,20).join(', ')) + '</p>' : '') +
          '<p style="color:var(--gray-500)">Each recipient got their own one-time link. Track payment status in the list (To: shows the recipient).</p>' +
        '</div>'
      );
    }, 250);
    return;
  }

  var res = await apiFetch('/payment-links', { method: 'POST', body: JSON.stringify(body) });
  if (!res || !res.status) return show((res && res.message) || 'Could not create the link.');
  document.getElementById('modal').style.display = 'none';
  loadMerchPaymentLinks();
  var url = res.data.url;
  setTimeout(function() {
    showModal(
      '<div class="modal-header"><div class="modal-title">Payment Link Created</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
      '<div style="padding:6px 2px">' +
        '<div style="font-size:13px;color:var(--gray-500);margin-bottom:8px">Share this link with your customer:</div>' +
        '<div class="mono" style="background:#f7f7f7;padding:12px;border-radius:8px;word-break:break-all;font-size:13px" id="pl-new-url">' + _escA(url) + '</div>' +
        '<div style="text-align:center;margin:16px 0"><img alt="QR code" style="width:180px;height:180px" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(url) + '"></div>' +
        '<button class="btn btn-lime" style="width:100%" onclick="plCopy(document.getElementById(\'pl-new-url\').textContent,this)">Copy Link</button>' +
      '</div>'
    );
  }, 250);
}

function plCopy(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    if (btn) { var t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = t; }, 1500); }
  }).catch(function() { prompt('Copy this link:', text); });
}
function plShowQr(encUrl) {
  showModal('<div class="modal-header"><div class="modal-title">Payment Link QR</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="text-align:center;padding:16px"><img alt="QR code" style="width:240px;height:240px" src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encUrl + '"></div>');
}
async function plToggle(id, to) {
  var res = await apiFetch('/payment-links/' + id, { method: 'PATCH', body: JSON.stringify({ status: to }) });
  if (res && res.status) loadMerchPaymentLinks(); else alert('Error: ' + ((res && res.message) || 'Update failed'));
}
async function plDelete(id) {
  if (!confirm('Delete this payment link? This cannot be undone.')) return;
  var res = await apiFetch('/payment-links/' + id, { method: 'DELETE' });
  if (res && res.status) loadMerchPaymentLinks(); else alert('Error: ' + ((res && res.message) || 'Delete failed'));
}

// ── QR CODES tab — scan-to-pay codes (shares the Invoice & Collect /invoicing/qr API) ──
var _plQrList = [];
var _plQrCurrent = null;
var _plContacts = null;

async function plRenderQrTab() {
  var el = document.getElementById('pl-tab-body');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/invoicing/qr');
    if (!res || res.status === false) { el.innerHTML = errorBox((res && res.message) || 'Could not load QR codes'); return; }
    _plQrList = res.data || [];
    var rows = _plQrList.length ? _plQrList.map(function(q) {
      var amt = (q.amount === null || q.amount === undefined) ? '<span style="color:var(--gray-400)">Customer enters</span>' : fmtMoney(q.amount, 'NGN');
      var st  = q.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Disabled</span>';
      return '<tr>' +
        '<td><div style="font-weight:600">' + _escA(q.label || q.reference) + '</div>' +
          '<div style="font-size:11px;color:var(--gray-400)">' + _escA(q.reference) + '</div></td>' +
        '<td>' + (q.type === 'open' ? 'Open' : 'Fixed') + '</td>' +
        '<td>' + amt + '</td>' +
        '<td>' + st + '</td>' +
        '<td><div class="flex" style="gap:6px;flex-wrap:wrap">' +
          '<button class="btn btn-lime btn-sm" onclick="plQrView(\'' + q.id + '\')">View / Share</button>' +
          '<button class="btn btn-outline btn-sm" onclick="plQrToggle(\'' + q.id + '\',' + (q.is_active ? 'false' : 'true') + ')">' + (q.is_active ? 'Disable' : 'Enable') + '</button>' +
          '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="plQrDelete(\'' + q.id + '\')">Delete</button>' +
        '</div></td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:30px">No QR codes yet. Create one so customers can scan and pay.</td></tr>';
    el.innerHTML =
      '<div class="card"><div class="table-wrap"><table>' +
      '<thead><tr><th>Label</th><th>Type</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  } catch (e) {
    el.innerHTML = errorBox('Failed to load QR codes: ' + e.message);
  }
}

function plQrShowCreate() {
  showModal(
    '<div class="modal-header"><div class="modal-title">New QR Code</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="padding:4px 2px">' +
      '<div class="form-group"><label class="form-label">Type</label>' +
        '<select class="form-input form-select" id="qr-f-type" onchange="document.getElementById(\'qr-f-amtwrap\').style.display=this.value===\'fixed\'?\'block\':\'none\'">' +
          '<option value="fixed">Fixed amount</option><option value="open">Open amount (customer enters)</option></select></div>' +
      '<div class="form-group" id="qr-f-amtwrap"><label class="form-label">Amount (₦)</label>' +
        '<input class="form-input" id="qr-f-amount" type="number" min="1" step="0.01" placeholder="e.g. 5000"></div>' +
      '<div class="form-group"><label class="form-label">Label (optional)</label>' +
        '<input class="form-input" id="qr-f-label" placeholder="e.g. Bar, Front Desk, Event Gate"></div>' +
      '<div class="form-group"><label style="font-size:13px;display:flex;align-items:center;gap:8px"><input type="checkbox" id="qr-f-vat"> Charge 7.5% VAT — added on top of the amount.</label></div>' +
      '<div id="qr-f-msg" style="display:none;font-size:12px;color:var(--red);margin-bottom:8px"></div>' +
      '<div class="flex-between">' +
        '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
        '<button class="btn btn-lime" id="qr-f-btn" onclick="plQrCreate()">Generate QR</button>' +
      '</div>' +
    '</div>'
  );
}

async function plQrCreate() {
  var type = document.getElementById('qr-f-type').value;
  var msg  = document.getElementById('qr-f-msg');
  function err(t){ if(msg){ msg.textContent=t; msg.style.display='block'; } }
  var body = { type: type, label: document.getElementById('qr-f-label').value, charge_vat: document.getElementById('qr-f-vat').checked };
  if (type === 'fixed') {
    var a = parseFloat(document.getElementById('qr-f-amount').value);
    if (!a || a < 1) return err('Enter a valid amount.');
    body.amount = Math.round(a * 100);
  }
  var btn = document.getElementById('qr-f-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  var res = await apiFetch('/invoicing/qr', { method: 'POST', body: JSON.stringify(body) });
  if (!res || res.status === false) { if (btn) { btn.disabled = false; btn.textContent = 'Generate QR'; } return err((res && res.message) || 'Could not create the QR code.'); }
  document.getElementById('modal').style.display = 'none';
  await plRenderQrTab();
  plQrShowModal(res.data);
}

function plQrView(id) {
  var q = _plQrList.filter(function(x){ return x.id === id; })[0];
  if (q) plQrShowModal(q);
}

function plQrShowModal(q) {
  _plQrCurrent = q;
  var amtLabel = (q.amount === null || q.amount === undefined) ? 'Customer enters amount' : fmtMoney(q.amount, 'NGN');
  showModal(
    '<div class="modal-header"><div class="modal-title">' + _escA(q.label || q.reference) + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="padding:4px 2px">' +
      '<div style="text-align:center;margin-bottom:8px">' +
        '<div style="font-size:12px;color:var(--gray-500);margin-bottom:8px">' + amtLabel + ' · ' + (q.type === 'open' ? 'Open' : 'Fixed') + '</div>' +
        '<div id="qr-img-box" style="min-height:200px;display:flex;align-items:center;justify-content:center">' + loading() + '</div>' +
      '</div>' +
      '<div class="mono" id="qr-payurl" style="background:#f7f7f7;padding:10px;border-radius:8px;word-break:break-all;font-size:12px">' + _escA(q.pay_url) + '</div>' +
      '<div class="flex" style="gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="btn btn-outline btn-sm" onclick="plCopy(document.getElementById(\'qr-payurl\').textContent,this)">Copy link</button>' +
        '<button class="btn btn-outline btn-sm" onclick="plQrDownload(\'' + q.id + '\',\'png\')">Download PNG</button>' +
        '<button class="btn btn-outline btn-sm" onclick="plQrDownload(\'' + q.id + '\',\'svg\')">Download SVG</button>' +
      '</div>' +
      '<div style="border-top:1px solid var(--gray-200);margin:14px 0 10px"></div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--gray-600);margin-bottom:8px">Share this QR</div>' +
      '<div id="qr-contacts-wrap" class="form-group" style="margin-bottom:8px"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<div><label class="form-label">Email</label><input class="form-input" id="qr-share-email" type="email" placeholder="customer@email.com"></div>' +
        '<div><label class="form-label">WhatsApp phone</label><input class="form-input" id="qr-share-phone" type="tel" placeholder="080..."></div>' +
      '</div>' +
      '<div class="flex" style="gap:8px;margin-top:10px">' +
        '<button class="btn btn-outline" style="flex:1" id="qr-share-email-btn" onclick="plQrShareEmail()">✉ Email this QR</button>' +
        '<button class="btn btn-lime" style="flex:1" onclick="plQrShareWhatsApp()">Share via WhatsApp</button>' +
      '</div>' +
      '<div id="qr-share-msg" style="display:none;font-size:12px;margin-top:8px"></div>' +
    '</div>'
  );
  plQrLoadImg(q.id);
  plQrLoadContacts();
}

function plQrShareText(q) {
  var amt = (q.amount === null || q.amount === undefined) ? '' : ' (' + fmtMoney(q.amount, 'NGN') + ')';
  return 'Pay ' + (q.label ? q.label + ' ' : '') + 'securely via Paylode' + amt + ':\n' + q.pay_url;
}
async function plQrShareEmail() {
  var q = _plQrCurrent; if (!q) return;
  var email = (document.getElementById('qr-share-email').value || '').trim();
  var msg = document.getElementById('qr-share-msg');
  function say(t, good) { if (msg) { msg.textContent = t; msg.style.color = good ? 'var(--green)' : 'var(--red)'; msg.style.display = 'block'; } }
  if (!email || email.indexOf('@') < 0) return say('Enter a valid email address.', false);
  var btn = document.getElementById('qr-share-email-btn'); if (btn) { btn.disabled = true; }
  say('Sending…', true);
  var res = await apiFetch('/invoicing/qr/' + q.id + '/share', { method: 'POST', body: JSON.stringify({ email: email }) });
  if (btn) btn.disabled = false;
  if (res && res.status !== false) say(res.message || ('QR emailed to ' + email), true);
  else say((res && res.message) || 'Could not send the email.', false);
}
function plQrShareWhatsApp() {
  var q = _plQrCurrent; if (!q) return;
  var phone = (document.getElementById('qr-share-phone').value || '').replace(/[^0-9]/g, '');
  if (phone.indexOf('0') === 0) phone = '234' + phone.slice(1);
  else if (phone && phone.indexOf('234') !== 0 && phone.length === 10) phone = '234' + phone;
  window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(plQrShareText(q)), '_blank');
}

async function plQrLoadImg(id) {
  var box = document.getElementById('qr-img-box'); if (!box) return;
  try {
    var token = sessionStorage.getItem('paylode_token');
    var r = await fetch(API_BASE + '/invoicing/qr/' + id + '/image?format=png', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('img');
    var u = URL.createObjectURL(await r.blob());
    box.innerHTML = '<img alt="QR code" src="' + u + '" style="width:220px;height:220px;border:1px solid var(--gray-200);border-radius:8px">';
  } catch (e) { box.innerHTML = '<div style="font-size:12px;color:var(--red)">Could not load QR image</div>'; }
}
async function plQrLoadContacts() {
  var wrap = document.getElementById('qr-contacts-wrap'); if (!wrap) return;
  try {
    if (_plContacts === null) {
      var res = await apiFetch('/invoicing/contacts');
      _plContacts = (res && res.data) ? res.data : [];
    }
    if (!_plContacts.length) { wrap.innerHTML = ''; return; }
    var opts = '<option value="">— choose from contacts —</option>' + _plContacts.map(function(c, i) {
      return '<option value="' + i + '">' + _escA(c.name || c.email || c.phone || ('Contact ' + (i + 1))) + '</option>';
    }).join('');
    wrap.innerHTML = '<label class="form-label">Address book</label><select class="form-input form-select" id="qr-contact-pick" onchange="plQrPickContact(this.value)">' + opts + '</select>';
  } catch (e) { wrap.innerHTML = ''; }
}
function plQrPickContact(i) {
  if (i === '' || !_plContacts) return;
  var c = _plContacts[Number(i)]; if (!c) return;
  if (c.email) document.getElementById('qr-share-email').value = c.email;
  if (c.phone) document.getElementById('qr-share-phone').value = c.phone;
}

async function plQrDownload(id, format) {
  var token = sessionStorage.getItem('paylode_token');
  try {
    var r = await fetch(API_BASE + '/invoicing/qr/' + id + '/image?format=' + format, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { alert('Could not download the QR image.'); return; }
    var u = URL.createObjectURL(await r.blob());
    var a = document.createElement('a');
    a.href = u; a.download = 'paylode-qr-' + id + '.' + format;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(u); }, 1000);
  } catch (e) { alert('Download failed: ' + e.message); }
}
async function plQrToggle(id, active) {
  var res = await apiFetch('/invoicing/qr/' + id, { method: 'PATCH', body: JSON.stringify({ is_active: active }) });
  if (res && res.status !== false) plRenderQrTab(); else alert('Error: ' + ((res && res.message) || 'Update failed'));
}
async function plQrDelete(id) {
  if (!confirm('Delete this QR code? This cannot be undone.')) return;
  var res = await apiFetch('/invoicing/qr/' + id, { method: 'DELETE' });
  if (res && res.status !== false) plRenderQrTab(); else alert('Error: ' + ((res && res.message) || 'Delete failed'));
}

function showGenerateKeyModal() {
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Generate New API Key</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Contact <strong>support@paylodeservices.com</strong> to request new API keys. Keys are provisioned after KYC verification to prevent unauthorized access.</div>' +
    '<div class="form-group"><label class="form-label">Your registered email</label><input class="form-input" id="gen-email" value="' + (getUser().email||'') + '" readonly></div>' +
    '<div class="form-group"><label class="form-label">Key type needed</label>' +
    '<select class="form-input form-select" id="gen-type"><option value="test">Test (Sandbox)</option><option value="live">Live (Production)</option></select></div>' +
    '<div class="form-group"><label class="form-label">Reason / notes</label><textarea class="form-input" id="gen-reason" rows="3" placeholder="e.g. Launching new integration, lost key..."></textarea></div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="submitKeyRequest()">Send Request</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function submitKeyRequest() {
  alert('Request submitted! Support will provision your key and send it to your registered email within 1 business day.');
  document.getElementById('modal').style.display = 'none';
}

// ── MERCHANT WEBHOOKS ─────────────────────────────────────────────────────────
async function loadMerchWebhooks() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var cfg = await apiFetch('/webhooks/config');
    var webhookUrl = cfg?.data?.webhook_url || null;
    var events     = cfg?.data?.events || [];

    var endpointHtml = webhookUrl
      ? '<div class="rev-row" style="padding:14px 0"><div style="flex:1;min-width:0">' +
          '<div class="flex" style="gap:8px;margin-bottom:4px"><span class="badge badge-green">Active</span><span style="font-weight:600;font-size:13px">' + webhookUrl + '</span></div>' +
          '<div style="font-size:11px;color:var(--gray-400)">Events: ' + events.join(' · ') + '</div>' +
        '</div>' +
        '<div class="flex" style="gap:6px;margin-left:12px">' +
          '<button class="btn btn-outline btn-sm" onclick="testWebhook()">&#9654; Test</button>' +
          '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="removeWebhook()">Remove</button>' +
        '</div></div>'
      : '<div style="text-align:center;padding:32px;color:var(--gray-400)">' +
          '<div style="font-size:24px;margin-bottom:8px">&#8700;</div>' +
          '<div style="font-size:14px;font-weight:500;margin-bottom:4px">No webhook endpoint configured</div>' +
          '<div style="font-size:12px">Add an endpoint to receive real-time payment events</div>' +
        '</div>';

    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">Webhooks</div>' +
        '<div class="page-desc">Receive real-time notifications for payment events</div></div>' +
        '<button class="btn btn-lime" onclick="showAddEndpointModal()">+ Add Endpoint</button>' +
      '</div>' +
      '<div class="card" style="margin-bottom:16px">' +
        '<div class="card-header"><div class="card-title">Configured Endpoint</div></div>' +
        endpointHtml +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">Supported Events</div></div>' +
        events.map(function(e) { return '<div class="rev-row"><code style="font-size:12px;background:var(--gray-100);padding:2px 8px;border-radius:4px">' + e + '</code><span style="font-size:12px;color:var(--gray-400)">' + ({
          'payment.success':'Payment completed successfully',
          'payment.failed':'Payment attempt failed',
          'payment.pending':'Payment awaiting confirmation',
          'refund.processed':'Refund processed to customer',
          'settlement.completed':'Settlement disbursed to your bank',
          'chargeback.created':'Chargeback raised on a transaction',
        }[e]||'') + '</span></div>'; }).join('') +
      '</div>' +
      '<div id="webhook-test-result"></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load webhooks: ' + e.message);
  }
}

function showAddEndpointModal() {
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Add Webhook Endpoint</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Paylode will send a POST request to this URL for each subscribed event. The endpoint must respond with a 2xx status code within 10 seconds.</div>' +
    '<div class="form-group"><label class="form-label">Endpoint URL <span style="color:var(--red)">*</span></label>' +
    '<input class="form-input" id="wh-url" placeholder="https://your-server.com/webhooks/paylode" type="url">' +
    '<div class="form-hint">Must use HTTPS</div></div>' +
    '<div id="wh-alert"></div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" id="wh-save-btn" onclick="saveWebhookEndpoint()">Save Endpoint</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function saveWebhookEndpoint() {
  var url = (document.getElementById('wh-url').value || '').trim();
  var alertEl = document.getElementById('wh-alert');
  if (!url) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">URL is required</div>'; return; }
  if (!url.startsWith('https://')) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Endpoint must use HTTPS</div>'; return; }
  var btn = document.getElementById('wh-save-btn');
  btn.textContent = 'Saving...'; btn.disabled = true;
  var res = await apiFetch('/webhooks/config', { method: 'PUT', body: JSON.stringify({ webhook_url: url }) });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    loadMerchWebhooks();
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Failed to save endpoint') + '</div>';
    btn.textContent = 'Save Endpoint'; btn.disabled = false;
  }
}

async function testWebhook() {
  var resultEl = document.getElementById('webhook-test-result');
  if (resultEl) resultEl.innerHTML = '<div class="info-box" style="margin-top:12px">Sending test webhook... ⟳</div>';
  var res = await apiFetch('/webhooks/test', { method: 'POST' });
  if (!resultEl) resultEl = document.getElementById('webhook-test-result');
  if (!resultEl) return;
  if (res && res.data) {
    var d = res.data;
    var success = d.success;
    resultEl.innerHTML = '<div style="margin-top:12px;background:' + (success?'#f0fdf4':'#fff1f2') + ';border:1px solid ' + (success?'#bbf7d0':'#fecdd3') + ';border-radius:8px;padding:16px">' +
      '<div style="font-weight:700;font-size:14px;color:' + (success?'#15803d':'#be123c') + ';margin-bottom:8px">' + (success?'&#10003; Test passed':'&#10007; Test failed') + '</div>' +
      '<div class="rev-row"><span class="rev-label">URL</span><span class="rev-value" style="font-size:12px;font-family:monospace">' + (d.url||'—') + '</span></div>' +
      '<div class="rev-row"><span class="rev-label">HTTP Status</span><span class="rev-value">' + (d.status_code||'—') + '</span></div>' +
      '<div class="rev-row"><span class="rev-label">Response Time</span><span class="rev-value">' + (d.duration_ms||'—') + 'ms</span></div>' +
      (d.error ? '<div class="warn-box" style="margin-top:8px;font-size:12px">Error: ' + d.error + '</div>' : '') +
      (d.response ? '<div style="margin-top:8px"><div style="font-size:11px;color:var(--gray-400);margin-bottom:4px">Response body:</div><div style="background:var(--gray-100);padding:8px;border-radius:4px;font-size:11px;font-family:monospace">' + d.response + '</div></div>' : '') +
    '</div>';
  } else {
    if (resultEl) resultEl.innerHTML = '<div class="warn-box" style="margin-top:12px">' + ((res && res.message) || 'Test failed') + '</div>';
  }
}

async function removeWebhook() {
  if (!confirm('Remove this webhook endpoint? Paylode will stop sending events to it immediately.')) return;
  var res = await apiFetch('/webhooks/config', { method: 'PUT', body: JSON.stringify({ webhook_url: null }) });
  if (res && res.status) loadMerchWebhooks();
  else alert('Error: ' + ((res && res.message) || 'Failed to remove endpoint'));
}

// ── USER MANAGEMENT ───────────────────────────────────────────────────────────
async function loadUserManagement() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/users');
    var users = (res && res.data) ? res.data : [];

    var roleColors = {
      SUPER_ADMIN:'badge-purple', ADMIN:'badge-blue', COMPLIANCE_OFFICER:'badge-amber',
      AGGREGATOR:'badge-lime', MERCHANT:'badge-green'
    };
    var roleLabels = {
      SUPER_ADMIN:'Super Admin', ADMIN:'Admin', COMPLIANCE_OFFICER:'Compliance Officer',
      AGGREGATOR:'Aggregator', MERCHANT:'Merchant'
    };

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div><div class="page-title">User Management</div>' +
          '<div class="page-desc">All platform users — staff, aggregators, and merchants</div></div>' +
        '<button class="btn btn-lime" onclick="showInviteUserModal()">+ Invite User</button>' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>' +
        '<tbody>' +
        (users.length ? users.map(function(u) {
          var rk  = (u.role || '').toUpperCase();
          var rbadge = '<span class="badge ' + (roleColors[rk]||'badge-gray') + '">' + (roleLabels[rk]||u.role) + '</span>';
          var st  = (u.isActive === false || u.status === 'inactive') ? 'inactive' : 'active';
          return '<tr>' +
            '<td style="font-weight:500">' + ((u.firstName||'') + ' ' + (u.lastName||'')).trim() + '</td>' +
            '<td style="font-size:12px">' + (u.email||'—') + '</td>' +
            '<td>' + rbadge + '</td>' +
            '<td>' + statusBadge(st) + '</td>' +
            '<td style="font-size:12px">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-NG') : '—') + '</td>' +
            '<td>' +
              (st === 'active'
                ? '<button class="btn btn-outline btn-sm" onclick="setUserStatus(\'' + u.id + '\',\'deactivate\')">Deactivate</button>'
                : '<button class="btn btn-outline btn-sm" onclick="setUserStatus(\'' + u.id + '\',\'activate\')">Activate</button>') +
              ' <button class="btn btn-outline btn-sm" onclick="resetTempPassword(\'' + u.id + '\',\'' + (u.email||'').replace(/'/g,'') + '\')">Resend Temp Pwd</button>' +
            '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--gray-400)">No users found</td></tr>') +
        '</tbody>' +
      '</table></div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load users: ' + e.message);
  }
}

function showInviteUserModal() {
  // Super admin can invite anyone; admin can only invite aggregators and merchants
  var allRoles = [
    ['SUPER_ADMIN',        'Super Admin'],
    ['ADMIN',              'Admin'],
    ['COMPLIANCE_OFFICER', 'Compliance Officer'],
    ['AGGREGATOR',         'Aggregator'],
    ['MERCHANT',           'Merchant'],
  ];
  var allowedRoles = (currentRole === 'superadmin')
    ? allRoles
    : allRoles.filter(function(r) { return r[0] === 'AGGREGATOR' || r[0] === 'MERCHANT'; });

  var roleOpts = allowedRoles.map(function(r) {
    return '<option value="' + r[0] + '">' + r[1] + '</option>';
  }).join('');

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header">' +
      '<div class="modal-title">Invite New User</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button>' +
    '</div>' +
    (currentRole === 'admin' ? '<div class="info-box" style="margin-bottom:16px;font-size:12px">As Admin, you can invite Aggregators and Merchants only. Contact Super Admin to invite staff roles.</div>' : '') +
    '<div class="form-group"><label class="form-label">Full Name <span style="color:var(--red)">*</span></label>' +
      '<input class="form-input" id="inv-fname" placeholder="First and last name"></div>' +
    '<div class="form-group"><label class="form-label">Email Address <span style="color:var(--red)">*</span></label>' +
      '<input class="form-input" type="email" id="inv-femail" placeholder="user@example.com"></div>' +
    '<div class="form-grid">' +
      '<div class="form-group"><label class="form-label">Role <span style="color:var(--red)">*</span></label>' +
        '<select class="form-input form-select" id="inv-frole">' + roleOpts + '</select></div>' +
      '<div class="form-group"><label class="form-label">Phone Number</label>' +
        '<input class="form-input" id="inv-fphone" placeholder="+234 800 000 0000"></div>' +
    '</div>' +
    '<div class="warn-box" style="font-size:12px;margin-bottom:16px">An invitation email will be sent with a link to set their password. The link expires in 48 hours.</div>' +
    '<div class="flex-between">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" id="inv-submit-btn" onclick="submitInviteUser()">Send Invitation</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function submitInviteUser() {
  var name  = (document.getElementById('inv-fname').value || '').trim();
  var email = (document.getElementById('inv-femail').value || '').trim();
  var role  = document.getElementById('inv-frole').value;
  var phone = (document.getElementById('inv-fphone').value || '').trim();
  if (!name || !email || !role) { alert('Name, email and role are required'); return; }

  var btn = document.getElementById('inv-submit-btn');
  btn.textContent = 'Sending...'; btn.disabled = true;

  var res = await apiFetch('/users/invite', {
    method: 'POST',
    body: JSON.stringify({ name: name, email: email, role: role, phone: phone }),
  });
  if (res && res.status) {
    alert('Invitation sent successfully to ' + email + '.\nThey will receive a link to set their password.');
    document.getElementById('modal').style.display = 'none';
    loadUserManagement();
  } else {
    alert('Error: ' + ((res && res.message) || 'Failed to send invitation'));
    btn.textContent = 'Send Invitation'; btn.disabled = false;
  }
}

async function setUserStatus(id, action) {
  var label = action === 'deactivate' ? 'Deactivate' : 'Activate';
  if (!confirm(label + ' this user?')) return;
  var res = await apiFetch('/users/' + id + '/' + action, { method: 'PUT' });
  if (res && res.status) { loadUserManagement(); }
  else alert('Error: ' + ((res && res.message) || 'Action failed'));
}

// ── RAIL SETTLEMENT REPORT (by rail + product) ───────────────────────────────
async function loadRailSettlement() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var now = new Date();
    var from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    var to   = now.toISOString().split('T')[0];

    var res = await apiFetch('/reports/rail-settlement?from=' + from + '&to=' + to);
    if (!res || !res.data) { el.innerHTML = errorBox('Could not load rail settlement report'); return; }
    var d = res.data;
    var totalsBy = d.totals_by_currency || { NGN:{}, USD:{} };
    var byRail = d.by_rail || [];
    var byRailProduct = d.by_rail_product || [];

    // Render one full table for a given currency
    function currencyTable(ccy) {
      var rails = byRail.filter(function(r){ return (r.currency||'NGN') === ccy; });
      var prods = byRailProduct.filter(function(p){ return (p.currency||'NGN') === ccy; });
      var sections = rails.map(function(rail) {
        var products = prods.filter(function(p){ return p.rail_name === rail.rail_name; });
        var prows = products.map(function(p) {
          return '<tr>' +
            '<td style="padding-left:24px"><span class="tag">' + (p.product||'—') + '</span></td>' +
            '<td style="text-align:center">' + fmtNum(p.txn_count) + '</td>' +
            '<td class="mono">' + fmtMajor(p.volume_major, ccy) + '</td>' +
            '<td class="mono text-lime">' + fmtMajor(p.fee_revenue_major, ccy) + '</td>' +
            '<td class="mono text-red">' + fmtMajor(p.rail_cost_major, ccy) + '</td>' +
            '<td class="mono" style="font-weight:600">' + fmtMajor(p.margin_major, ccy) + '</td>' +
          '</tr>';
        }).join('');
        return '<tr style="background:var(--gray-50)">' +
            '<td style="font-weight:700">' + rail.rail_name + (rail.rail_status ? ' <span class="badge badge-gray" style="font-size:10px">' + rail.rail_status + '</span>' : '') + '</td>' +
            '<td style="text-align:center;font-weight:700">' + fmtNum(rail.txn_count) + '</td>' +
            '<td class="mono" style="font-weight:700">' + fmtMajor(rail.volume_major, ccy) + '</td>' +
            '<td class="mono text-lime" style="font-weight:700">' + fmtMajor(rail.fee_revenue_major, ccy) + '</td>' +
            '<td class="mono text-red" style="font-weight:700">' + fmtMajor(rail.rail_cost_major, ccy) + '</td>' +
            '<td class="mono" style="font-weight:700">' + fmtMajor(rail.margin_major, ccy) + '</td>' +
          '</tr>' + prows;
      }).join('');
      var empty = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--gray-400)">No ' + (ccy==='USD'?'international (USD)':'local (NGN)') + ' rail activity this period.</td></tr>';
      return '<div class="table-wrap"><table>' +
        '<thead><tr><th>Rail / Product</th><th>Txns</th><th>Volume</th><th>Fee Revenue</th><th>Rail Cost</th><th>Margin</th></tr></thead>' +
        '<tbody>' + (sections || empty) + '</tbody></table></div>';
    }

    function totalsRow(ccy) {
      var t = totalsBy[ccy] || {};
      return '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-label">Volume</div><div class="stat-value">' + fmtMajor(t.volume_major, ccy) + '</div><div class="stat-sub">' + fmtNum(t.txn_count||0) + ' txns</div></div>' +
        '<div class="stat-card"><div class="stat-label">Fee Revenue</div><div class="stat-value text-lime">' + fmtMajor(t.fee_revenue_major, ccy) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Rail Costs</div><div class="stat-value text-red">' + fmtMajor(t.rail_cost_major, ccy) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Margin</div><div class="stat-value">' + fmtMajor(t.margin_major, ccy) + '</div></div>' +
      '</div>';
    }

    // International card breakdown by scheme (Visa / Mastercard / Amex / Diners)
    function schemeBreakdown(schemes) {
      var dot = { VISA:'#1a1f71', MASTERCARD:'#eb001b', AMEX:'#2e77bc', DINERS:'#0079be', UNSPECIFIED:'#94a3b8' };
      var rows = schemes.length ? schemes.map(function(s) {
        return '<tr>' +
          '<td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (dot[s.scheme]||'#94a3b8') + ';margin-right:8px"></span>' + (s.scheme_label||s.scheme) + '</td>' +
          '<td style="text-align:center">' + fmtNum(s.txn_count) + '</td>' +
          '<td class="mono">' + fmtMajor(s.volume_major,'USD') + '</td>' +
          '<td class="mono text-lime">' + fmtMajor(s.fee_revenue_major,'USD') + '</td>' +
          '<td class="mono" style="font-weight:600">' + fmtMajor(s.margin_major,'USD') + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--gray-400)">No international card transactions this period.</td></tr>';
      return '<div class="card" style="border:1px solid #bfdbfe"><div class="card-header"><div class="card-title">USD — By Card Scheme</div>' +
        '<div style="font-size:11px;color:var(--gray-400)">International cards split by scheme · "Unspecified" = flat rate (scheme not detected)</div></div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr><th>Card Scheme</th><th>Txns</th><th>Volume</th><th>Fee Revenue</th><th>Margin</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>' +
      '</div>';
    }

    el.innerHTML =
      '<div class="page-header flex-between"><div>' +
        '<div class="page-title">Rail Settlement Report</div>' +
        '<div class="page-desc">Earnings by rail and product — local and international reported separately — ' + from + ' to ' + to + '</div>' +
      '</div>' +
        '<button class="btn btn-outline btn-sm" onclick="exportRailSettlement()">&#8681; Export CSV</button>' +
        '<button class="btn btn-outline btn-sm" onclick="emailRailSettlement()">&#9993; Email to me</button>' +
      '</div>' +

      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-gray">₦ Local (NGN)</span></div>' +
      totalsRow('NGN') +
      '<div class="card" style="margin-bottom:20px"><div class="card-header"><div class="card-title">NGN — By Rail &amp; Product</div>' +
        '<div style="font-size:11px;color:var(--gray-400)">Bold = rail total · indented = product</div></div>' +
        currencyTable('NGN') +
      '</div>' +

      '<div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-blue">🌍 International (USD)</span><span style="font-size:12px;color:var(--gray-400)">International card transactions — all values in US Dollars</span></div>' +
      totalsRow('USD') +
      '<div class="card" style="border:1px solid #bfdbfe;margin-bottom:16px"><div class="card-header"><div class="card-title">USD — By Rail &amp; Product</div>' +
        '<div style="font-size:11px;color:var(--gray-400)">Settled in US Dollars</div></div>' +
        currencyTable('USD') +
      '</div>' +
      schemeBreakdown(d.by_scheme || []);

    window._railSettlementData = d;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load rail settlement: ' + e.message);
  }
}

function _buildRailSettlementCsv() {
  var d = window._railSettlementData;
  if (!d) return null;
  var headers = ['Section','Currency','Rail/Scheme','Product','Txns','Volume','Fee Revenue','Rail Cost','Margin'];
  var rows = (d.by_rail_product || []).map(function(p) {
    return ['Rail x Product', p.currency||'NGN', p.rail_name, p.product||'', p.txn_count, p.volume_major, p.fee_revenue_major, p.rail_cost_major, p.margin_major];
  });
  (d.by_scheme || []).forEach(function(s) {
    rows.push(['Card Scheme (USD)', 'USD', s.scheme_label||s.scheme, 'International Card', s.txn_count, s.volume_major, s.fee_revenue_major, '', s.margin_major]);
  });
  var csv = '﻿' + [headers].concat(rows).map(function(r) { return r.map(function(v) { return '"' + String(v) + '"'; }).join(','); }).join('\n');
  return { csv: csv, filename: 'rail-settlement-' + new Date().toISOString().split('T')[0] + '.csv' };
}
function exportRailSettlement() {
  var b = _buildRailSettlementCsv(); if (!b) { alert('No data to export'); return; }
  _downloadText(b.csv, b.filename, 'text/csv');
}
async function emailRailSettlement() {
  var b = _buildRailSettlementCsv(); if (!b) { alert('No data to email'); return; }
  await emailReportFile(b.filename, _utf8ToBase64(b.csv), 'text/csv');
}

// ── FEE CONFIGURATION PAGE ───────────────────────────────────────────────────
async function loadFeeConfig() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/merchants/platform-rates');
    if (!res || !res.data) { el.innerHTML = errorBox('Could not load merchant pricing'); return; }
    // New response shape: { rates:[], rails:[] }. Fall back to array for safety.
    var payload = res.data;
    var rates = Array.isArray(payload) ? payload : (payload.rates || []);
    var rails = Array.isArray(payload) ? [] : (payload.rails || []);
    window._feeConfigRails = rails;

    function byGroup(group) { return rates.filter(function(r) { return r.product_group === group; }); }
    function naira(kobo) { return kobo > 0 ? '&#8358;' + (kobo/100).toLocaleString(undefined,{minimumFractionDigits:2}) : '—'; }
    function feeModelLabel(m) { return {PCT:'% of Amount',FLAT:'Flat Fee',PCT_PLUS_FLAT:'% + Flat Fee',GREATER_OF:'Greater of % or Flat'}[m]||m; }

    function exampleCalc(r) {
      var amt = 1000000; // ₦10,000 in kobo
      var fee = 0;
      var ratePct = Number(r.rate);
      var flat = Number(r.flat_fee);
      var cap  = Number(r.cap);
      var minC = Number(r.min_charge);
      var vat  = Number(r.vat_rate) || 0.075;
      switch(r.fee_model) {
        case 'FLAT':          fee = flat; break;
        case 'PCT_PLUS_FLAT': fee = Math.round(amt * ratePct) + flat; break;
        case 'GREATER_OF':    fee = Math.max(Math.round(amt*ratePct), flat); break;
        default:              fee = Math.round(amt * ratePct) + flat;
      }
      if (minC > 0 && fee < minC) fee = minC;
      if (cap  > 0 && fee > cap)  fee = cap;
      var vatAmt = Math.round(fee * vat);
      return '<span style="font-size:11px;color:var(--gray-500)">₦10,000 txn → Fee: ₦' + (fee/100).toLocaleString(undefined,{minimumFractionDigits:2}) + ' + VAT: ₦' + (vatAmt/100).toLocaleString(undefined,{minimumFractionDigits:2}) + ' = ₦' + ((fee+vatAmt)/100).toLocaleString(undefined,{minimumFractionDigits:2}) + '</span>';
    }

    function rateCard(r) {
      var vatPct = ((Number(r.vat_rate)||0.075)*100).toFixed(1);
      return '<div class="card" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:200px">' +
          '<div style="font-weight:700;font-size:14px;margin-bottom:4px">' + (r.label||r.channel) +
            (r.is_custom ? ' <span class="badge badge-amber" style="font-size:10px">Custom</span>' : '') +
            (!r.is_active ? ' <span class="badge badge-red" style="font-size:10px">Inactive</span>' : '') +
          '</div>' +
          '<div style="font-size:12px;color:var(--gray-500);margin-bottom:8px">' + (r.description||r.notes||r.channel) + '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px">' +
            '<span class="badge badge-gray">' + feeModelLabel(r.fee_model) + '</span>' +
            (r.rate > 0 ? '<span class="badge badge-blue">' + (Number(r.rate)*100).toFixed(2) + '% rate</span>' : '') +
            (r.flat_fee > 0 ? '<span class="badge badge-purple">&#8358;' + (r.flat_fee/100).toLocaleString() + ' flat</span>' : '') +
            (r.min_charge > 0 ? '<span class="badge badge-lime">Min: &#8358;' + (r.min_charge/100).toLocaleString() + '</span>' : '') +
            (r.cap > 0 ? '<span class="badge badge-amber">Cap: &#8358;' + (r.cap/100).toLocaleString() + '</span>' : '') +
            '<span class="badge badge-gray">VAT: ' + vatPct + '%</span>' +
            (r.default_rail_name ? '<span class="badge badge-green">Rail: ' + r.default_rail_name + '</span>' : (r.product_group !== 'CUSTOM' ? '<span class="badge badge-red">No rail set</span>' : '')) +
          '</div>' +
          exampleCalc(r) +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0">' +
          '<button class="btn btn-outline btn-sm" onclick="editPlatformRate(\'' + r.channel + '\')">&#9998; Edit</button>' +
          (r.is_custom ? '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deletePlatformRate(\'' + r.channel + '\',\'' + (r.label||r.channel).replace(/'/g,"\\'") + '\')">Delete</button>' : '') +
        '</div>' +
      '</div></div>';
    }

    function section(title, icon, desc, group, emptyMsg) {
      var items = byGroup(group);
      return '<div class="section-gap"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div><div style="font-size:16px;font-weight:700;color:var(--gray-800)">' + icon + ' ' + title + '</div>' +
          '<div style="font-size:12px;color:var(--gray-500);margin-top:2px">' + desc + '</div></div>' +
        (group === 'CUSTOM' ? '<button class="btn btn-lime btn-sm" onclick="addCustomCharge()">+ Add Custom Charge</button>' : '') +
      '</div>' +
      (items.length ? items.map(rateCard).join('') : '<div class="info-box" style="font-size:12px">' + emptyMsg + '</div>') +
      '</div>';
    }

    // International card SCHEME overrides (Visa / Mastercard / Amex / Diners).
    // Each can carry its own rate; if unset, the flat International Card rate applies.
    function schemePanel() {
      var flat = rates.find(function(r){ return r.channel === 'CARD_INTL'; });
      var flatPct = flat ? (Number(flat.rate)*100).toFixed(2) + '%' : '3.50%';
      var schemes = [
        ['VISA','Visa','#1a1f71'], ['MASTERCARD','Mastercard','#eb001b'],
        ['AMEX','American Express','#2e77bc'], ['DINERS','Diners Club','#0079be'],
      ];
      var cards = schemes.map(function(sc) {
        var ch = 'CARD_INTL_' + sc[0];
        var cfg = rates.find(function(r){ return r.channel === ch; });
        var feeModelTxt = cfg ? (Number(cfg.rate)*100).toFixed(2) + '%' +
            (cfg.flat_fee>0 ? ' + $' + (cfg.flat_fee/100).toFixed(2) : '') +
            (cfg.cap>0 ? ' (cap $' + (cfg.cap/100).toFixed(2) + ')' : '')
          : null;
        return '<div style="border:1px solid var(--gray-200);border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<div style="display:flex;align-items:center;gap:10px">' +
            '<span style="width:8px;height:8px;border-radius:50%;background:' + sc[2] + '"></span>' +
            '<div><div style="font-weight:700;font-size:13px">' + sc[1] + '</div>' +
            (cfg
              ? '<div style="font-size:12px;color:#1e40af">Custom rate: <strong>' + feeModelTxt + '</strong> · USD</div>'
              : '<div style="font-size:12px;color:var(--gray-400)">Uses flat International rate (' + flatPct + ')</div>') +
            '</div></div>' +
          '<div style="display:flex;gap:6px">' +
            '<button class="btn btn-outline btn-sm" onclick="editCardScheme(\'' + sc[0] + '\',\'' + sc[1] + '\')">' + (cfg ? '✎ Edit' : '+ Set rate') + '</button>' +
            (cfg ? '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="clearCardScheme(\'' + sc[0] + '\',\'' + sc[1] + '\')">Revert to flat</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
      return '<div class="section-gap"><div style="margin-bottom:12px">' +
          '<div style="font-size:15px;font-weight:700;color:var(--gray-800)">🌍 International Card Schemes (USD)</div>' +
          '<div style="font-size:12px;color:var(--gray-500);margin-top:2px">Optionally charge different rates per scheme. Visa, Mastercard, Amex and Diners often have different scheme fees. Unset schemes use the flat International Card rate (' + flatPct + ').</div>' +
        '</div>' +
        '<div class="card" style="border:1px solid #bfdbfe;display:flex;flex-direction:column;gap:10px">' + cards + '</div>' +
      '</div>';
    }

    el.innerHTML =
      '<div class="page-header flex-between"><div>' +
        '<div class="page-title">Merchant Pricing</div>' +
        '<div class="page-desc">Default rates we charge merchants, per product (override per merchant). This is our PRICE to merchants — distinct from rail/provider cost. All fees include 7.5% VAT as required by Nigerian law.</div>' +
      '</div>' +
        '<div class="flex" style="gap:8px">' +
          '<button class="btn btn-outline btn-sm" onclick="loadFeeConfig()">&#8635; Refresh</button>' +
          '<button class="btn btn-primary btn-sm" onclick="addCustomCharge()">+ Custom Charge</button>' +
        '</div>' +
      '</div>' +

      '<div class="warn-box" style="margin-bottom:20px"><strong>VAT Notice:</strong> All fees are subject to 7.5% Value Added Tax (VAT) as mandated by Nigerian law (FIRS). ' +
      'The fee displayed and charged to merchants is always <strong>fee + VAT</strong>. Merchants cannot opt out of VAT. ' +
      'The VAT rate is configurable per product should the statutory rate change.</div>' +

      section('Card Payments', '&#9879;', 'Fees applied when merchants accept card payments. Separate rates for local and international cards.',
        'CARDS', 'No card rates configured.') +

      schemePanel() +

      section('Virtual Accounts / Bank Transfer', '&#8960;', 'Fees applied when merchants receive money via bank transfer to a virtual account.',
        'VIRTUAL_ACCOUNT', 'No virtual account rates configured.') +

      section('Payouts (Outbound Transfers)', '&#8680;', 'Fees charged when merchants send money to beneficiaries. Deducted from merchant wallet.',
        'PAYOUT', 'No payout rates configured.') +

      section('Custom Charges', '&#9881;', 'Additional fees configured by super admin — e.g., FX surcharge, chargeback fee, monthly platform fee.',
        'CUSTOM', 'No custom charges added yet. Click "+ Add Custom Charge" to create one.');

    window._feeConfigRates = rates;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load merchant pricing: ' + e.message);
  }
}

function editPlatformRate(channel) {
  var rates = window._feeConfigRates || [];
  var r = rates.find(function(x) { return x.channel === channel; }) || {};

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Edit — ' + (r.label||channel) + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px"><strong>Channel:</strong> ' + channel + ' &nbsp;|&nbsp; <strong>Product:</strong> ' + (r.product_group||'') + '<br>' +
    (r.description||'') + '</div>' +

    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Fee Model</label>' +
    '<select class="form-input form-select" id="pr-model" onchange="previewFeeCalc()">' +
      ['PCT','FLAT','PCT_PLUS_FLAT','GREATER_OF'].map(function(m) {
        var labels = {PCT:'% of Amount',FLAT:'Flat Fee Only',PCT_PLUS_FLAT:'% + Flat Fee',GREATER_OF:'Greater of % or Flat'};
        return '<option value="' + m + '"' + (r.fee_model===m?' selected':'') + '>' + labels[m] + '</option>';
      }).join('') +
    '</select></div>' +
    '<div class="form-group"><label class="form-label">VAT Rate (e.g. 0.075 = 7.5%)</label>' +
    '<input class="form-input" type="number" id="pr-vat" step="0.001" min="0" max="1" value="' + (Number(r.vat_rate)||0.075) + '" onchange="previewFeeCalc()"></div>' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Rate (%) — e.g. 1.5 for 1.5%</label>' +
    '<input class="form-input" type="number" id="pr-rate" step="0.01" min="0" max="100" value="' + ((Number(r.rate)||0)*100).toFixed(4) + '" oninput="previewFeeCalc()"></div>' +
    '<div class="form-group"><label class="form-label">Flat Fee (&#8358;)</label>' +
    '<input class="form-input" type="number" id="pr-flat" step="1" min="0" value="' + (Number(r.flat_fee||0)/100).toFixed(2) + '" oninput="previewFeeCalc()"></div>' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Min Charge (&#8358;, 0 = none)</label>' +
    '<input class="form-input" type="number" id="pr-min" step="1" min="0" value="' + (Number(r.min_charge||0)/100).toFixed(2) + '" oninput="previewFeeCalc()"></div>' +
    '<div class="form-group"><label class="form-label">Max Charge / Cap (&#8358;, 0 = none)</label>' +
    '<input class="form-input" type="number" id="pr-cap" step="1" min="0" value="' + (Number(r.cap||0)/100).toFixed(2) + '" oninput="previewFeeCalc()"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Label / Display Name</label>' +
    '<input class="form-input" id="pr-label" value="' + (r.label||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">Description</label>' +
    '<input class="form-input" id="pr-desc" value="' + (r.description||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">Internal Notes</label>' +
    '<input class="form-input" id="pr-notes" value="' + (r.notes||'') + '"></div>' +

    '<div class="divider"></div>' +
    '<div style="font-weight:600;font-size:13px;margin-bottom:8px">Rail Routing</div>' +
    '<div class="info-box" style="font-size:12px;margin-bottom:12px">Choose which payment rail processes this product by default. This rail\'s cost is deducted from the fee, and the settlement report groups earnings by rail.</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Default Rail for this product</label>' +
    '<select class="form-input form-select" id="pr-rail">' +
      '<option value="">— No rail assigned —</option>' +
      (window._feeConfigRails || []).map(function(rl) {
        return '<option value="' + rl.id + '"' + (r.default_rail_id === rl.id ? ' selected' : '') + '>' + rl.name + ' (' + rl.status + ')</option>';
      }).join('') +
    '</select></div>' +
    '<div class="form-group"><label class="form-label">Settles as Channel</label>' +
    '<select class="form-input form-select" id="pr-txnchannel">' +
      ['', 'CARD', 'BANK_TRANSFER', 'USSD', 'DIRECT_DEBIT'].map(function(c) {
        return '<option value="' + c + '"' + (r.txn_channel === c ? ' selected' : '') + '>' + (c || '— Auto —') + '</option>';
      }).join('') +
    '</select></div>' +
    '</div>' +

    '<div style="background:var(--gray-100);border-radius:8px;padding:12px;margin-bottom:16px" id="pr-preview">' +
    '<div style="font-size:11px;color:var(--gray-500);margin-bottom:4px">Live preview (₦10,000 transaction)</div>' +
    '<div id="pr-preview-val" style="font-size:13px;font-weight:600">—</div></div>' +

    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="savePlatformRate(\'' + channel + '\',\'' + (r.product_group||'OTHER') + '\')">Save Changes</button>' +
    '</div>';

  document.getElementById('modal').style.display = 'flex';
  previewFeeCalc();
}

function previewFeeCalc() {
  var amt      = 1000000; // ₦10,000 in kobo
  var ratePct  = parseFloat(document.getElementById('pr-rate')?.value || 0) / 100;
  var flat     = Math.round((parseFloat(document.getElementById('pr-flat')?.value || 0)) * 100);
  var minC     = Math.round((parseFloat(document.getElementById('pr-min')?.value  || 0)) * 100);
  var cap      = Math.round((parseFloat(document.getElementById('pr-cap')?.value  || 0)) * 100);
  var vat      = parseFloat(document.getElementById('pr-vat')?.value  || 0.075);
  var model    = document.getElementById('pr-model')?.value || 'PCT';

  var fee = 0;
  switch (model) {
    case 'FLAT':          fee = flat; break;
    case 'PCT_PLUS_FLAT': fee = Math.round(amt * ratePct) + flat; break;
    case 'GREATER_OF':    fee = Math.max(Math.round(amt * ratePct), flat); break;
    default:              fee = Math.round(amt * ratePct) + flat;
  }
  if (minC > 0 && fee < minC) fee = minC;
  if (cap  > 0 && fee > cap)  fee = cap;
  var vatAmt = Math.round(fee * vat);
  var total  = fee + vatAmt;

  var el = document.getElementById('pr-preview-val');
  if (el) {
    var f = function(k) { return '&#8358;' + (k/100).toLocaleString(undefined,{minimumFractionDigits:2}); };
    el.innerHTML = 'Fee: ' + f(fee) + ' + VAT (' + (vat*100).toFixed(1) + '%): ' + f(vatAmt) + ' = <strong>' + f(total) + '</strong> total charged to merchant';
  }
}

async function savePlatformRate(channel, productGroup) {
  var rate  = parseFloat(document.getElementById('pr-rate').value) / 100;
  var flat  = Math.round(parseFloat(document.getElementById('pr-flat').value || 0) * 100);
  var minC  = Math.round(parseFloat(document.getElementById('pr-min').value  || 0) * 100);
  var cap   = Math.round(parseFloat(document.getElementById('pr-cap').value  || 0) * 100);
  var vat   = parseFloat(document.getElementById('pr-vat').value  || 0.075);
  var model = document.getElementById('pr-model').value;
  var label = document.getElementById('pr-label').value;
  var desc  = document.getElementById('pr-desc').value;
  var notes = document.getElementById('pr-notes').value;
  var railEl = document.getElementById('pr-rail');
  var chEl   = document.getElementById('pr-txnchannel');
  var defaultRailId = railEl ? (railEl.value || null) : null;
  var txnChannel    = chEl ? (chEl.value || null) : null;

  if (isNaN(rate)) { alert('Enter a valid rate'); return; }

  var res = await apiFetch('/merchants/platform-rates', {
    method: 'PUT',
    body: JSON.stringify({
      channel, product_group: productGroup, fee_model: model,
      rate, flat_fee: flat, min_charge: minC, cap,
      vat_rate: vat, label, description: desc, notes,
      default_rail_id: defaultRailId, txn_channel: txnChannel,
    }),
  });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    loadFeeConfig();
  } else {
    alert('Error: ' + ((res && res.message) || 'Save failed'));
  }
}

function addCustomCharge() {
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Add Custom Charge</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Custom charges can represent any additional fee — FX surcharge, chargeback processing fee, monthly platform fee, etc.</div>' +
    '<div class="form-group"><label class="form-label">Charge Name (e.g. FX Surcharge) <span style="color:var(--red)">*</span></label>' +
    '<input class="form-input" id="cc-label" placeholder="e.g. FX Surcharge"></div>' +
    '<div class="form-group"><label class="form-label">Description</label>' +
    '<input class="form-input" id="cc-desc" placeholder="What is this charge for?"></div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Fee Model</label>' +
    '<select class="form-input form-select" id="cc-model">' +
      '<option value="PCT">% of Amount</option><option value="FLAT">Flat Fee</option>' +
      '<option value="PCT_PLUS_FLAT">% + Flat Fee</option><option value="GREATER_OF">Greater of % or Flat</option>' +
    '</select></div>' +
    '<div class="form-group"><label class="form-label">Rate (%)</label>' +
    '<input class="form-input" type="number" id="cc-rate" step="0.01" min="0" value="0" placeholder="0"></div>' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Flat Fee (&#8358;)</label>' +
    '<input class="form-input" type="number" id="cc-flat" step="1" min="0" value="0"></div>' +
    '<div class="form-group"><label class="form-label">Cap / Max (&#8358;, 0=none)</label>' +
    '<input class="form-input" type="number" id="cc-cap" step="1" min="0" value="0"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">VAT Rate (default 0.075 = 7.5%)</label>' +
    '<input class="form-input" type="number" id="cc-vat" step="0.001" min="0" value="0.075"></div>' +
    '<div id="cc-alert"></div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="submitCustomCharge()">Add Charge</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function submitCustomCharge() {
  var label = document.getElementById('cc-label').value.trim();
  var desc  = document.getElementById('cc-desc').value.trim();
  var model = document.getElementById('cc-model').value;
  var rate  = parseFloat(document.getElementById('cc-rate').value) / 100;
  var flat  = Math.round(parseFloat(document.getElementById('cc-flat').value || 0) * 100);
  var cap   = Math.round(parseFloat(document.getElementById('cc-cap').value  || 0) * 100);
  var vat   = parseFloat(document.getElementById('cc-vat').value || 0.075);
  var alertEl = document.getElementById('cc-alert');

  if (!label) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Charge name is required</div>'; return; }

  var channel = 'CUSTOM_' + label.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 30);

  var res = await apiFetch('/merchants/platform-rates', {
    method: 'PUT',
    body: JSON.stringify({
      channel, product_group: 'CUSTOM', fee_model: model, is_custom: true,
      rate, flat_fee: flat, cap, vat_rate: vat, label, description: desc,
    }),
  });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    loadFeeConfig();
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Failed to add charge') + '</div>';
  }
}

async function deletePlatformRate(channel, label) {
  if (!confirm('Delete custom charge "' + label + '"?\nThis cannot be undone.')) return;
  var res = await apiFetch('/merchants/platform-rates/' + encodeURIComponent(channel), { method: 'DELETE' });
  if (res && res.status) { loadFeeConfig(); }
  else alert('Error: ' + ((res && res.message) || 'Delete failed'));
}

// ── International card scheme rates (Visa / Mastercard / Amex / Diners) ────────
function editCardScheme(scheme, label) {
  var rates = window._feeConfigRates || [];
  var ch = 'CARD_INTL_' + scheme;
  var cfg = rates.find(function(x){ return x.channel === ch; });
  var flat = rates.find(function(x){ return x.channel === 'CARD_INTL'; }) || {};
  // Prefill from existing scheme config, else from the flat international rate as a starting point.
  var src = cfg || flat;

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">' + label + ' rate (International, USD)</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Set a rate that applies only to <strong>' + label + '</strong> international cards. All amounts are in <strong>USD</strong>. Leave or revert to use the flat International Card rate.</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Fee Model</label>' +
    '<select class="form-input form-select" id="cs-model">' +
      ['PCT','FLAT','PCT_PLUS_FLAT','GREATER_OF'].map(function(m){
        var labels={PCT:'% of Amount',FLAT:'Flat Fee Only',PCT_PLUS_FLAT:'% + Flat Fee',GREATER_OF:'Greater of % or Flat'};
        return '<option value="'+m+'"'+((src.fee_model||'PCT')===m?' selected':'')+'>'+labels[m]+'</option>';
      }).join('') + '</select></div>' +
    '<div class="form-group"><label class="form-label">VAT Rate (e.g. 0.075)</label>' +
    '<input class="form-input" type="number" id="cs-vat" step="0.001" min="0" max="1" value="' + (Number(src.vat_rate)||0.075) + '"></div>' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Rate (%) — e.g. 3.9</label>' +
    '<input class="form-input" type="number" id="cs-rate" step="0.01" min="0" max="100" value="' + ((Number(src.rate)||0.035)*100).toFixed(2) + '"></div>' +
    '<div class="form-group"><label class="form-label">Flat Fee ($)</label>' +
    '<input class="form-input" type="number" id="cs-flat" step="0.01" min="0" value="' + (Number(src.flat_fee||0)/100).toFixed(2) + '"></div>' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Min Charge ($, 0=none)</label>' +
    '<input class="form-input" type="number" id="cs-min" step="0.01" min="0" value="' + (Number(src.min_charge||0)/100).toFixed(2) + '"></div>' +
    '<div class="form-group"><label class="form-label">Max Charge / Cap ($, 0=none)</label>' +
    '<input class="form-input" type="number" id="cs-cap" step="0.01" min="0" value="' + (Number(src.cap||0)/100).toFixed(2) + '"></div>' +
    '</div>' +
    '<div class="flex-between">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="saveCardScheme(\'' + scheme + '\',\'' + label.replace(/\'/g,"") + '\')">Save ' + label + ' rate</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}

async function saveCardScheme(scheme, label) {
  var rate  = parseFloat(document.getElementById('cs-rate').value) / 100;
  var flat  = Math.round(parseFloat(document.getElementById('cs-flat').value || 0) * 100);
  var minC  = Math.round(parseFloat(document.getElementById('cs-min').value  || 0) * 100);
  var cap   = Math.round(parseFloat(document.getElementById('cs-cap').value  || 0) * 100);
  var vat   = parseFloat(document.getElementById('cs-vat').value || 0.075);
  var model = document.getElementById('cs-model').value;
  if (isNaN(rate)) { alert('Enter a valid rate'); return; }
  var res = await apiFetch('/merchants/platform-rates', {
    method: 'PUT',
    body: JSON.stringify({
      channel: 'CARD_INTL_' + scheme, product_group: 'CARDS', fee_model: model,
      rate: rate, flat_fee: flat, min_charge: minC, cap: cap, vat_rate: vat,
      label: label + ' (International)', description: label + ' international card rate (USD)',
    }),
  });
  if (res && res.status) { document.getElementById('modal').style.display = 'none'; loadFeeConfig(); }
  else alert('Error: ' + ((res && res.message) || 'Save failed'));
}

async function clearCardScheme(scheme, label) {
  if (!confirm('Revert ' + label + ' to the flat International Card rate?\nThe ' + label + '-specific rate will be removed.')) return;
  var res = await apiFetch('/merchants/platform-rates/CARD_INTL_' + scheme, { method: 'DELETE' });
  if (res && res.status) { loadFeeConfig(); }
  else alert('Error: ' + ((res && res.message) || 'Failed'));
}

// ── PAYOUT LOGS (merchant + super admin) ─────────────────────────────────────
async function loadPayoutLogs(page=1, filters={}) {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var url = '/payouts/logs?page=' + page + '&perPage=30';
    if (filters.status)      url += '&status=' + filters.status;
    if (filters.merchant_id) url += '&merchant_id=' + filters.merchant_id;
    if (filters.from)        url += '&from=' + filters.from;
    if (filters.to)          url += '&to=' + filters.to;
    if (filters.batch_ref)   url += '&batch_ref=' + encodeURIComponent(filters.batch_ref);

    var res = await apiFetch(url);
    if (!res || !res.data) { el.innerHTML = errorBox('Could not load payout logs'); return; }
    var items = res.data.data || [];
    var meta  = res.data.meta || { page: 1, pages: 1, total: 0 };

    var statusBtns = ['','queued','processing','success','failed'].map(function(s) {
      var active = (filters.status||'') === s;
      return '<button class="btn ' + (active ? 'btn-primary' : 'btn-outline') + ' btn-sm" ' +
        'onclick="loadPayoutLogs(1,{status:\'' + s + '\'})">' + (s||'All') + '</button>';
    }).join('&nbsp;');

    var rows = items.length ? items.map(function(i) {
      var failRow = i.status === 'failed' && i.failure_reason
        ? '<div style="font-size:11px;color:var(--red);margin-top:2px">&#9888; ' + i.failure_reason + '</div>'
        : '';
      return '<tr>' +
        '<td class="mono" style="font-size:11px">' + (i.batch_ref||'—') + '</td>' +
        '<td style="font-size:12px">' + (i.business_name||'—') + '<br><span class="mono" style="font-size:10px;color:var(--gray-400)">' + (i.merchant_code||'') + '</span></td>' +
        '<td class="mono" style="font-size:12px">' + (i.account_number||'—') + '<br><span style="font-size:11px;color:var(--gray-400)">' + (i.bank_name||i.bank_code||'') + '</span></td>' +
        '<td style="font-weight:600">' + fmtNaira(i.amount) + '</td>' +
        '<td class="mono" style="font-size:12px;color:var(--amber)">' + (i.fee_naira > 0 ? fmtNaira(i.fee_naira*100) : '—') + '</td>' +
        '<td class="mono" style="font-size:12px;color:var(--gray-500)">' + (i.vat_naira > 0 ? fmtNaira(i.vat_naira*100) : '—') + '</td>' +
        '<td>' + statusBadge(i.status) + failRow + '</td>' +
        '<td style="font-size:12px;color:var(--gray-400)">' + (i.created_at ? new Date(i.created_at).toLocaleDateString('en-NG') : '—') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--gray-400)">No payout items in this period</td></tr>';

    el.innerHTML =
      '<div class="page-header flex-between"><div>' +
        '<div class="page-title">Payout Transaction Logs</div>' +
        '<div class="page-desc">' + fmtNum(meta.total) + ' payout items total</div>' +
      '</div>' +
        '<div class="flex" style="gap:6px">' + statusBtns + '</div>' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Batch Ref</th><th>Merchant</th><th>Beneficiary</th><th>Amount</th><th>Fee</th><th>VAT</th><th>Status</th><th>Date</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '<div class="flex-between" style="margin-top:16px">' +
        '<div style="font-size:12px;color:var(--gray-500)">Page ' + meta.page + ' of ' + meta.pages + '</div>' +
        '<div class="flex">' +
          (meta.page > 1 ? '<button class="btn btn-outline btn-sm" onclick="loadPayoutLogs(' + (meta.page-1) + ')">← Previous</button>' : '') +
          (meta.page < meta.pages ? '<button class="btn btn-outline btn-sm" onclick="loadPayoutLogs(' + (meta.page+1) + ')">Next →</button>' : '') +
        '</div>' +
      '</div></div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load payout logs: ' + e.message);
  }
}

// ── SUPER ADMIN PAYOUT REPORT ────────────────────────────────────────────────
async function loadPayoutReport() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var now = new Date();
    var from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    var to   = now.toISOString().split('T')[0];

    var res = await apiFetch('/payouts/admin/report?from=' + from + '&to=' + to);
    if (!res || !res.data) { el.innerHTML = errorBox('Could not load payout report'); return; }
    var d = res.data;
    var s = d.summary || {};

    var merchantRows = (d.by_merchant || []).map(function(m) {
      return '<tr>' +
        '<td style="font-weight:500;font-size:13px">' + (m.business_name||'—') + '<br><span class="mono" style="font-size:10px;color:var(--gray-400)">' + (m.merchant_code||'') + '</span></td>' +
        '<td style="text-align:center">' + (m.batch_count||0) + '</td>' +
        '<td style="text-align:center">' + (m.total_items||0) + '</td>' +
        '<td style="text-align:center;color:var(--green)">' + (m.success_items||0) + '</td>' +
        '<td style="text-align:center;color:var(--red)">' + (m.failed_items||0) + '</td>' +
        '<td style="font-weight:600">' + fmtNaira((m.total_amount_naira||0)*100) + '</td>' +
        '<td style="font-weight:700;color:var(--lime-dark)">' + fmtNaira((m.fee_earned_naira||0)*100) + '</td>' +
        '<td class="mono" style="font-size:12px">' + (m.success_rate||'—') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--gray-400)">No payout activity this period</td></tr>';

    var failRows = (d.top_failure_reasons || []).map(function(f) {
      return '<div class="rev-row"><span class="rev-label" style="font-size:12px">' + (f.reason||'Unknown') + '</span><span class="rev-value"><span class="badge badge-red">' + f.count + '</span></span></div>';
    }).join('') || '<div style="color:var(--gray-400);font-size:12px;padding:12px">No failures this period</div>';

    var statusRows = (d.status_breakdown || []).map(function(st) {
      return '<div class="rev-row"><span class="rev-label">' + st.status + '</span><span class="rev-value">' + fmtNum(st.count) + '</span></div>';
    }).join('');

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div><div class="page-title">Payout Report</div><div class="page-desc">' + from + ' to ' + to + '</div></div>' +
        '<button class="btn btn-outline btn-sm" onclick="exportPayoutReport()">&#8681; Export CSV</button>' +
        '<button class="btn btn-outline btn-sm" onclick="emailPayoutReport()">&#9993; Email to me</button>' +
      '</div>' +
      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-label">Payout Batches</div><div class="stat-value">' + fmtNum(s.batch_count||0) + '</div><div class="stat-sub">' + (s.active_merchants||0) + ' merchants</div></div>' +
        '<div class="stat-card"><div class="stat-label">Total Payout Amount</div><div class="stat-value">' + fmtNaira((s.total_amount_naira||0)*100) + '</div><div class="stat-sub">' + fmtNum(s.total_items||0) + ' transactions</div></div>' +
        '<div class="stat-card"><div class="stat-label">Fee Earned</div><div class="stat-value text-lime">' + fmtNaira((s.fee_earned_naira||0)*100) + '</div><div class="stat-sub">+ VAT: ' + fmtNaira((s.vat_collected_naira||0)*100) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Success Rate</div><div class="stat-value">' + (s.total_items > 0 ? Math.round((s.success_items||0) / s.total_items * 100) + '%' : '—') + '</div><div class="stat-sub">' + (s.failed_items||0) + ' failed</div></div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="card"><div class="card-header"><div class="card-title">Status Breakdown</div></div>' + statusRows + '</div>' +
        '<div class="card"><div class="card-header"><div class="card-title">Top Failure Reasons</div></div>' + failRows + '</div>' +
      '</div>' +
      '<div class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">By Merchant</div></div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr><th>Merchant</th><th>Batches</th><th>Items</th><th>Success</th><th>Failed</th><th>Total Amount</th><th>Fee Earned</th><th>Success Rate</th></tr></thead>' +
          '<tbody id="payout-report-rows">' + merchantRows + '</tbody>' +
        '</table></div>' +
      '</div>';

    window._payoutReportData = d;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load payout report: ' + e.message);
  }
}

function _buildPayoutReportCsv() {
  var d = window._payoutReportData;
  if (!d) return null;
  var headers = ['Merchant','Code','Batches','Items','Success','Failed','Amount (NGN)','Fee Earned (NGN)','VAT (NGN)','Success Rate'];
  var rows = (d.by_merchant || []).map(function(m) {
    return [
      m.business_name, m.merchant_code,
      m.batch_count, m.total_items, m.success_items, m.failed_items,
      (m.total_amount_naira||0).toFixed(2),
      (m.fee_earned_naira||0).toFixed(2),
      (m.vat_collected_naira||0).toFixed(2),
      m.success_rate||'0%',
    ];
  });
  var csv = '﻿' + [headers].concat(rows).map(function(r) { return r.map(function(v) { return '"' + String(v) + '"'; }).join(','); }).join('\n');
  return { csv: csv, filename: 'payout-report-' + new Date().toISOString().split('T')[0] + '.csv' };
}
function exportPayoutReport() { var b = _buildPayoutReportCsv(); if (!b) { alert('No report data to export'); return; } _downloadText(b.csv, b.filename, 'text/csv'); }
async function emailPayoutReport() { var b = _buildPayoutReportCsv(); if (!b) { alert('No report data to email'); return; } await emailReportFile(b.filename, _utf8ToBase64(b.csv), 'text/csv'); }

// ── SETTLEMENT STATEMENT ──────────────────────────────────────────────────────
async function downloadStatement() {
  var monthEl = document.getElementById('stmt-month');
  var month = monthEl ? monthEl.value : new Date().toISOString().slice(0,7);
  var from = month + '-01';
  var lastDay = new Date(month.split('-')[0], parseInt(month.split('-')[1]), 0).getDate();
  var to = month + '-' + String(lastDay).padStart(2,'0');

  var btn = document.querySelector('[onclick="downloadStatement()"]');
  if (btn) { btn.textContent = '⟳ Generating...'; btn.disabled = true; }

  try {
    var res = await apiFetch('/reports/merchant-statement?from=' + from + '&to=' + to + '&perPage=500');
    if (!res || !res.data) throw new Error('Could not fetch statement data');
    var d = res.data;
    var m = d.merchant;
    var period = from + ' to ' + to;
    var txns = d.transactions || [];

    var fmt = function(n) { return '₦' + Number(n||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2}); };
    var rows = txns.map(function(t) {
      return '<tr>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:11px">' + t.reference + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:12px">' + new Date(t.date).toLocaleDateString('en-NG') + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-size:12px">' + t.channel + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600">' + fmt(t.amount) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#ef4444">' + fmt(t.fee) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#10b981">' + fmt(t.net) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #f1f5f9"><span style="background:' + (t.status==='SUCCESS'?'#d1fae5':t.status==='FAILED'?'#fee2e2':'#fef3c7') + ';color:' + (t.status==='SUCCESS'?'#065f46':t.status==='FAILED'?'#991b1b':'#92400e') + ';padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">' + t.status + '</span></td>' +
      '</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement - ' + (m&&m.businessName||'Merchant') + '</title>' +
      '<style>body{font-family:Arial,sans-serif;margin:0;padding:20px;color:#1e293b}table{width:100%;border-collapse:collapse}th{padding:10px 8px;background:#1a2744;color:#fff;font-size:11px;text-align:left;text-transform:uppercase}</style>' +
      '</head><body>' +
      '<div style="background:#1a2744;padding:20px;color:#fff;border-radius:8px 8px 0 0"><div style="font-size:18px;font-weight:700;color:#7dc534">Paylode Services Limited</div><div style="font-size:11px;opacity:.6">CBN Licensed PSSP · Merchant Account Statement</div></div>' +
      '<div style="background:#f8fafc;padding:16px;border:1px solid #e2e8f0;border-top:none;margin-bottom:16px"><div style="font-weight:700;font-size:16px;margin-bottom:4px">' + (m&&m.businessName||'—') + '</div>' +
      '<div style="font-size:12px;color:#64748b">Code: ' + (m&&m.merchantCode||'—') + ' &nbsp;·&nbsp; Period: ' + period + '</div>' +
      '<div style="display:flex;gap:16px;margin-top:12px">' +
      '<div><div style="font-size:11px;color:#64748b">Total Collections</div><div style="font-size:18px;font-weight:700">' + fmt(d.summary&&d.summary.total_collections) + '</div></div>' +
      '<div><div style="font-size:11px;color:#64748b">Fees Paid</div><div style="font-size:18px;font-weight:700;color:#ef4444">' + fmt(d.summary&&d.summary.total_fees_paid) + '</div></div>' +
      '<div><div style="font-size:11px;color:#064e3b">Net Settled</div><div style="font-size:18px;font-weight:700;color:#10b981">' + fmt(d.summary&&d.summary.net_settled) + '</div></div>' +
      '</div></div>' +
      '<table><thead><tr><th>Reference</th><th>Date</th><th>Channel</th><th>Amount</th><th>Fee</th><th>Net</th><th>Status</th></tr></thead>' +
      '<tbody>' + (rows||'<tr><td colspan="7" style="text-align:center;padding:20px;color:#94a3b8">No transactions in this period</td></tr>') + '</tbody></table>' +
      '<div style="margin-top:20px;font-size:11px;color:#94a3b8;text-align:center">Generated by Paylode Services Limited · support@paylodeservices.com</div>' +
      '</body></html>';

    var w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(function() { w.print(); }, 500);
  } catch(e) {
    alert('Failed to generate statement: ' + e.message);
  } finally {
    if (btn) { btn.innerHTML = '&#8681; Download PDF'; btn.disabled = false; }
  }
}

async function emailStatement() {
  var monthEl = document.getElementById('stmt-month');
  var month = monthEl ? monthEl.value : new Date().toISOString().slice(0,7);
  var from = month + '-01';
  var lastDay = new Date(month.split('-')[0], parseInt(month.split('-')[1]), 0).getDate();
  var to = month + '-' + String(lastDay).padStart(2,'0');

  var user = getUser();
  if (!confirm('Email the ' + month + ' statement to ' + (user.email||'your registered email') + '?')) return;

  var btn = document.querySelector('[onclick="emailStatement()"]');
  if (btn) { btn.textContent = '⟳ Sending...'; btn.disabled = true; }

  try {
    var res = await apiFetch('/reports/statement-email', { method: 'POST', body: JSON.stringify({ from: from, to: to }) });
    if (res && res.status) {
      alert('Statement emailed successfully to ' + (res.data&&res.data.sent_to || user.email) + '.');
    } else {
      alert('Failed to send email: ' + ((res && res.message) || 'Unknown error'));
    }
  } catch(e) {
    alert('Error: ' + e.message);
  } finally {
    if (btn) { btn.innerHTML = '&#9993; Email to Me'; btn.disabled = false; }
  }
}

// ── 2FA SETUP ─────────────────────────────────────────────────────────────────
async function setup2FA() {
  var msgEl = document.getElementById('tfa-msg');
  if (msgEl) msgEl.innerHTML = '<div class="info-box" style="font-size:12px">Generating your 2FA secret... ⟳</div>';

  try {
    var res = await apiFetch('/auth/2fa/setup', { method: 'POST' });
    if (!res || !res.data) { if (msgEl) msgEl.innerHTML = '<div class="warn-box" style="font-size:12px">' + ((res&&res.message)||'Setup failed') + '</div>'; return; }

    var secret = res.data.secret;
    var uri    = res.data.otp_uri;

    document.getElementById('modal-inner').innerHTML =
      '<div class="modal-header"><div class="modal-title">Set Up Two-Factor Authentication</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
      '<div class="info-box" style="margin-bottom:16px;font-size:12px"><strong>Step 1:</strong> Open Google Authenticator, Authy, or any TOTP app and scan the QR code below (or enter the key manually).</div>' +
      '<div style="text-align:center;margin-bottom:16px">' +
        '<canvas id="totp-qr-canvas" width="200" height="200" style="border:4px solid white;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.15)"></canvas>' +
        '<div style="margin-top:8px;font-size:11px;color:var(--gray-400)">Or enter manually:</div>' +
        '<div class="mono" style="background:var(--gray-100);padding:8px 16px;border-radius:6px;font-size:13px;letter-spacing:2px;margin-top:4px;display:inline-block">' + secret + '</div>' +
      '</div>' +
      '<div class="info-box" style="margin-bottom:16px;font-size:12px"><strong>Step 2:</strong> Enter the 6-digit code from your app to confirm it is working.</div>' +
      '<div class="form-group"><label class="form-label">Authenticator Code</label>' +
      '<input class="form-input" id="tfa-confirm-code" placeholder="000 000" maxlength="7" style="font-size:20px;letter-spacing:4px;text-align:center;font-family:monospace"></div>' +
      '<div id="tfa-confirm-alert"></div>' +
      '<div class="flex-between">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" id="tfa-confirm-btn" onclick="confirm2FA()">Enable 2FA</button>' +
      '</div>';
    document.getElementById('modal').style.display = 'flex';

    // Render QR code on canvas using simple pixel drawing
    renderQR(uri, document.getElementById('totp-qr-canvas'));
  } catch(e) {
    if (msgEl) msgEl.innerHTML = '<div class="warn-box" style="font-size:12px">Error: ' + e.message + '</div>';
  }
}

function renderQR(text, canvas) {
  // Use Google Charts API to generate QR (client-side rendered in img tag)
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 200, 200);
  // Replace canvas with img using chart API
  var img = document.createElement('img');
  img.src = 'https://chart.googleapis.com/chart?chs=200x200&chld=M%7C0&cht=qr&chl=' + encodeURIComponent(text);
  img.width = 200; img.height = 200;
  img.onerror = function() {
    // Fallback: show URI text
    ctx.fillStyle = '#1a2744'; ctx.font = '10px monospace'; ctx.fillText('Scan with app:', 8, 20);
    ctx.fillText('Copy URI below', 8, 36);
  };
  img.onload = function() { ctx.drawImage(img, 0, 0, 200, 200); };
  canvas.parentNode.replaceChild(img, canvas);
  img.id = 'totp-qr-img';
}

async function confirm2FA() {
  var code = (document.getElementById('tfa-confirm-code').value || '').replace(/\s/g,'');
  var alertEl = document.getElementById('tfa-confirm-alert');
  if (code.length !== 6) { alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Enter the 6-digit code from your app</div>'; return; }
  var btn = document.getElementById('tfa-confirm-btn');
  btn.textContent = 'Verifying...'; btn.disabled = true;
  var res = await apiFetch('/auth/2fa/confirm', { method: 'POST', body: JSON.stringify({ code: code }) });
  if (res && res.status) {
    document.getElementById('modal').style.display = 'none';
    alert('2FA enabled successfully! Every future login will require your authenticator code.');
    // Update local user cache
    var u = getUser(); u.totpEnabled = true; sessionStorage.setItem('paylode_user', JSON.stringify(u));
    // Re-render settings page
    if (typeof renderPage === 'function') renderPage();
  } else {
    alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res&&res.message)||'Incorrect code. Try again.') + '</div>';
    btn.textContent = 'Enable 2FA'; btn.disabled = false;
  }
}

async function disable2FA() {
  var pw   = document.getElementById('tfa-dis-pw').value;
  var code = document.getElementById('tfa-dis-code').value.replace(/\s/g,'');
  var msgEl = document.getElementById('tfa-msg');
  if (!pw || !code) { if (msgEl) msgEl.innerHTML = '<div class="warn-box" style="font-size:12px">Enter your password and authenticator code</div>'; return; }
  var res = await apiFetch('/auth/2fa/disable', { method: 'POST', body: JSON.stringify({ password: pw, code: code }) });
  if (res && res.status) {
    alert('2FA has been disabled.');
    var u = getUser(); u.totpEnabled = false; sessionStorage.setItem('paylode_user', JSON.stringify(u));
    if (typeof renderPage === 'function') renderPage();
  } else {
    if (msgEl) msgEl.innerHTML = '<div class="warn-box" style="font-size:12px">' + ((res&&res.message)||'Disable failed. Check your password and code.') + '</div>';
  }
}

// ── AGGREGATOR REVENUE ────────────────────────────────────────────────────────
async function loadAggRevenue() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/aggregators/my/revenue');
    var payload = (res && res.data) ? res.data : {};
    var rows = Array.isArray(payload) ? payload : (payload.data || []);
    var mtdBy = payload.share_mtd_by_currency || { NGN:{}, USD:{} };
    var allBy = payload.share_all_by_currency || { NGN:{}, USD:{} };

    var tableHtml = rows.length ? rows.map(function(r) {
      return '<tr>' +
        '<td style="font-weight:500">' + (r.month||'—') + '</td>' +
        '<td class="mono">' + fmtNaira((r.merchant_volume||0)*100) + '</td>' +
        '<td class="mono">' + fmtNaira((r.gross_fees||0)*100) + '</td>' +
        '<td class="mono text-red">-' + fmtNaira((r.rail_costs||0)*100) + '</td>' +
        '<td class="mono">' + fmtNaira((r.net_pool||0)*100) + '</td>' +
        '<td class="mono text-lime" style="font-weight:700">' + fmtNaira((r.agg_share_naira||0)*100) + '</td>' +
        '<td>' + statusBadge(r.status||'pending') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray-400)">No monthly rollups yet</td></tr>';

    el.innerHTML =
      '<div class="page-header flex-between">' +
        '<div><div class="page-title">Revenue Share Statement</div>' +
          '<div class="page-desc">Your aggregator earnings — local (NGN) and international (USD) shown separately</div></div>' +
        '<button class="btn btn-outline btn-sm" onclick="downloadAggRevenueLive()">&#8681; Download CSV</button>' +
        '<button class="btn btn-outline btn-sm" onclick="emailAggRevenueLive()">&#9993; Email to me</button>' +
      '</div>' +

      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-gray">₦ Local (NGN)</span></div>' +
      '<div class="stats-grid" style="grid-template-columns:1fr 1fr 1fr">' +
        '<div class="stat-card"><div class="stat-label">Your Share (This Month)</div><div class="stat-value text-lime">' + fmtMajor(mtdBy.NGN&&mtdBy.NGN.agg_share||0,'NGN') + '</div><div class="stat-sub">' + fmtNum(mtdBy.NGN&&mtdBy.NGN.txn_count||0) + ' txns</div></div>' +
        '<div class="stat-card"><div class="stat-label">Your Share (All Time)</div><div class="stat-value" style="color:var(--lime-dark)">' + fmtMajor(allBy.NGN&&allBy.NGN.agg_share||0,'NGN') + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Merchant Fees (MTD)</div><div class="stat-value">' + fmtMajor(mtdBy.NGN&&mtdBy.NGN.merchant_fees||0,'NGN') + '</div></div>' +
      '</div>' +

      '<div class="section-gap" style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span class="badge badge-blue">🌍 International (USD)</span><span style="font-size:12px;color:var(--gray-400)">Share from international card transactions — settled in US Dollars</span></div>' +
      '<div class="stats-grid" style="grid-template-columns:1fr 1fr 1fr">' +
        '<div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Your Share (This Month)</div><div class="stat-value" style="color:#1e40af">' + fmtMajor(mtdBy.USD&&mtdBy.USD.agg_share||0,'USD') + '</div><div class="stat-sub">' + fmtNum(mtdBy.USD&&mtdBy.USD.txn_count||0) + ' intl txns</div></div>' +
        '<div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Your Share (All Time)</div><div class="stat-value" style="color:#1e40af">' + fmtMajor(allBy.USD&&allBy.USD.agg_share||0,'USD') + '</div></div>' +
        '<div class="stat-card" style="border:1px solid #bfdbfe;background:#f8fbff"><div class="stat-label">Merchant Fees (MTD)</div><div class="stat-value">' + fmtMajor(mtdBy.USD&&mtdBy.USD.merchant_fees||0,'USD') + '</div></div>' +
      '</div>' +

      '<div class="card section-gap"><div class="card-header"><div class="card-title">Monthly Breakdown (NGN rollups)</div></div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr><th>Month</th><th>Merchant Volume</th><th>Gross Fees</th><th>Rail Costs</th><th>Net Pool</th><th>Your Share</th><th>Status</th></tr></thead>' +
          '<tbody>' + tableHtml + '</tbody>' +
        '</table></div>' +
      '</div>';

    window._aggRevenueRows = rows;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load revenue data: ' + e.message);
  }
}

function _buildAggRevenueCsv() {
  var rows = window._aggRevenueRows || [];
  var headers = ['Month','Merchant Volume (NGN)','Gross Fees (NGN)','Rail Costs (NGN)','Net Pool (NGN)','Your Share (NGN)','Status'];
  var data = rows.map(function(r) {
    return [r.month, r.merchant_volume||0, r.gross_fees||0, r.rail_costs||0, r.net_pool||0, r.agg_share_naira||0, r.status||'pending'];
  });
  var csv = '﻿' + [headers].concat(data).map(function(r) { return r.map(function(v) { return '"' + String(v) + '"'; }).join(','); }).join('\n');
  return { csv: csv, filename: 'paylode-aggregator-revenue-' + new Date().toISOString().split('T')[0] + '.csv' };
}
function downloadAggRevenueLive() { var b = _buildAggRevenueCsv(); _downloadText(b.csv, b.filename, 'text/csv'); }
async function emailAggRevenueLive() { var b = _buildAggRevenueCsv(); await emailReportFile(b.filename, _utf8ToBase64(b.csv), 'text/csv'); }

// ── NAVIGATE FUNCTION ─────────────────────────────────────────────────────────
// Use window assignment (not function declaration) to avoid hoisting conflicts
window.navigate = function(page) {
  // Some nav ids live on a standalone static page (see EXTERNAL_PAGES in app.js)
  // rather than an in-app SPA view — redirect instead of rendering "coming soon".
  if (typeof EXTERNAL_PAGES !== 'undefined' && EXTERNAL_PAGES[page]) {
    window.location.href = EXTERNAL_PAGES[page];
    return;
  }
  // Record in-app history so both the on-screen "← Back" (goBack) and the
  // browser/phone Back button return to the PREVIOUS page (not the landing page).
  if (currentPage && currentPage !== page && String(page).indexOf('hub::') !== 0) {
    try { __navHistory.push(currentPage); } catch (e) {}
  }
  currentPage = page;
  renderNav();
  renderPage();
  loadPageData(page);
  closeSidebar();
  // Push a browser history entry so the device Back button fires popstate (caught
  // below) instead of unloading the SPA back to the landing page.
  try { history.pushState({ plPage: page }, ''); } catch (e) {}
};

// ── Keep the browser/phone Back button INSIDE the dashboard ──────────────────
// Without this the SPA never adds browser history, so the only entry is the
// landing page and every Back press exits the dashboard. We arm a history entry
// and, on Back, navigate in-app (popping __navHistory) and re-arm — so Back walks
// back through dashboard pages and never drops the user on the landing page.
(function armBackButtonTrap() {
  try {
    history.pushState({ plDash: true }, '');
    window.addEventListener('popstate', function () {
      var prev = (typeof __navHistory !== 'undefined' && __navHistory.length) ? __navHistory.pop() : null;
      if (!prev) {
        // At the dashboard home — stay put (logout is the way out), don't fall to landing.
        prev = (typeof ROLE_META !== 'undefined' && ROLE_META[currentRole] && ROLE_META[currentRole].defaultPage)
          ? ROLE_META[currentRole].defaultPage : currentPage;
      }
      if (prev) {
        currentPage = prev;
        if (typeof renderNav === 'function')  renderNav();
        if (typeof renderPage === 'function') renderPage();
        loadPageData(prev);
        if (typeof closeSidebar === 'function') closeSidebar();
      }
      try { history.pushState({ plDash: true }, ''); } catch (e) {}  // re-arm for the next Back
    });
  } catch (e) {}
})();

function toggleUserMenu(e) {
  e.stopPropagation();
  var m = document.getElementById('user-menu');
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', function() {
  var m = document.getElementById('user-menu');
  if (m) m.style.display = 'none';
});

// ── STAFF ISSUE REPORTER (technical chatbot / glitch report) ──────────────────
function showReportIssueModal() {
  var cats = ['Dashboard glitch','Data not loading','Permission / access','Document / KYC','Payment / settlement','Other'];
  var opts = cats.map(function(c){ return '<option value="' + c + '">' + c + '</option>'; }).join('');
  var inner =
    '<div class="modal-header"><div class="modal-title">&#9888; Report a Technical Issue</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="font-size:12px;color:var(--gray-500);margin-bottom:14px">Describe any glitch or problem you hit on your dashboard. It goes straight to the Paylode technical team.</div>' +
    '<div class="form-group"><label class="form-label">Category</label>' +
      '<select class="form-input form-select" id="ri-cat">' + opts + '</select></div>' +
    '<div class="form-group"><label class="form-label">What went wrong?</label>' +
      '<textarea class="form-input" id="ri-msg" rows="5" placeholder="e.g. The compliance queue shows a spinner and never loads when I click Review."></textarea></div>' +
    '<div class="flex-between" style="margin-top:8px">' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
      '<button class="btn btn-lime" id="ri-btn" onclick="submitIssueReport()">Send Report</button></div>' +
    '<div id="ri-msg-out" style="margin-top:8px"></div>';
  document.getElementById('modal-inner').innerHTML = inner;
  document.getElementById('modal').style.display = 'flex';
}
async function submitIssueReport() {
  var cat = document.getElementById('ri-cat').value;
  var msg = (document.getElementById('ri-msg').value || '').trim();
  var out = document.getElementById('ri-msg-out');
  if (!msg) { if (out) out.innerHTML = '<div class="warn-box" style="font-size:12px">Please describe the issue.</div>'; return; }
  var btn = document.getElementById('ri-btn'); if (btn) { btn.textContent = 'Sending...'; btn.disabled = true; }
  var res = await apiFetch('/support/report', { method:'POST',
    body: JSON.stringify({ category: cat, message: msg, page: (typeof currentPage !== 'undefined' ? currentPage : '') }) });
  if (out) out.innerHTML = (res && res.status)
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534;font-size:12px">&#10003; ' + (res.message || 'Report sent.') + '</div>'
    : '<div class="warn-box" style="font-size:12px">&#9888; ' + ((res && res.message) || 'Failed to send. Try again.') + '</div>';
  if (res && res.status) setTimeout(function(){ document.getElementById('modal').style.display = 'none'; }, 1400);
  else if (btn) { btn.textContent = 'Send Report'; btn.disabled = false; }
}

// ── DEAD-LETTER BANNER (onboarding applications that failed to persist) ───────
// Shown to SA/admin/compliance so a real application emailed-but-not-saved is
// never missed. Recoverable via Retry.
async function checkDeadLetters() {
  if (['superadmin', 'admin', 'compliance'].indexOf(currentRole) === -1) return;
  var main = document.querySelector('.main'); if (!main) return;
  var bar = document.getElementById('global-banner');
  try {
    var res = await apiFetch('/onboarding/dead-letter');
    var n = (res && res.data && res.data.count) || 0;
    if (!n) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'global-banner';
      var content = document.getElementById('main-content');
      content.parentNode.insertBefore(bar, content);
    }
    bar.innerHTML =
      '<div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 16px;margin:10px;border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px">' +
      '<span>&#9888; <strong>' + n + '</strong> onboarding application' + (n > 1 ? 's' : '') + ' failed to save and ' + (n > 1 ? 'are' : 'is') + ' not in the review queue (emailed only).</span>' +
      '<button class="btn btn-sm" style="background:#991b1b;color:#fff" onclick="showDeadLetterModal()">Review &amp; Recover</button>' +
      '</div>';
  } catch (e) { /* endpoint unavailable — silent */ }
}
async function showDeadLetterModal() {
  var res = await apiFetch('/onboarding/dead-letter');
  var items = (res && res.data && res.data.items) || [];
  var rows = items.length ? items.map(function (it) {
    return '<tr style="border-bottom:1px solid var(--gray-100)">' +
      '<td style="padding:8px;font-size:12px">' + (it.businessName || '—') + '<div style="color:var(--gray-400);font-size:11px">' + (it.contactEmail || '') + '</div></td>' +
      '<td style="padding:8px;font-size:11px">' + (it.formType || '—') + '</td>' +
      '<td style="padding:8px;font-size:11px;color:var(--gray-500)">' + (it.failedAt ? new Date(it.failedAt).toLocaleString('en-NG') : '—') + '<div style="color:var(--red);font-size:10px">' + (it.error || '') + '</div></td>' +
      '<td style="padding:8px"><button class="btn btn-lime btn-sm" onclick="retryDeadLetter(\'' + it.reference + '\')">Recover</button></td>' +
      '</tr>';
  }).join('') : '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--gray-400)">No failed applications</td></tr>';
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Failed Onboarding Applications</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="font-size:12px;color:var(--gray-500);margin-bottom:12px">These applications were received (and compliance was emailed) but could not be saved. Recover to push them into the review queue.</div>' +
    '<div class="table-wrap"><table style="width:100%;border-collapse:collapse"><thead><tr style="border-bottom:2px solid var(--gray-200)">' +
    '<th style="text-align:left;padding:8px;font-size:11px">Business</th><th style="text-align:left;padding:8px;font-size:11px">Type</th><th style="text-align:left;padding:8px;font-size:11px">Failed</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  document.getElementById('modal').style.display = 'flex';
}
async function retryDeadLetter(reference) {
  var res = await apiFetch('/onboarding/dead-letter/' + encodeURIComponent(reference) + '/retry', { method: 'POST' });
  if (res && res.status) { alert('Recovered into the review queue.'); document.getElementById('modal').style.display = 'none'; checkDeadLetters(); if (currentPage === 'onboarding_apps') loadOnboardingApps(); }
  else alert('Error: ' + ((res && res.message) || 'Recovery failed'));
}

// ── CENTRAL PAGE LOADER ────────────────────────────────────────────────────────
function loadPageData(page) {
  const role = currentRole;
  switch(page) {
    case 'overview':
      if (role === 'superadmin' || role === 'admin') loadSuperOverview();
      else if (role === 'aggregator') loadAggOverview();
      else if (role === 'merchant')   loadMerchantOverview();
      break;
    case 'agg_overview':     loadAggOverview(); break;
    case 'transactions':     loadTransactions(); break;
    case 'merchants':        loadMerchants(); break;
    case 'aggregators':      loadAggregators(); break;
    case 'compliance':       loadCompliance(); break;
    case 'revenue':          loadRevenueReport(); break;
    case 'settlement':       loadSettlements(); break;
    case 'sa_connections':   loadMerchantActivity(); break;
    case 'merch_overview':      loadMerchantOverview(); break;
    case 'merch_transactions':  loadTransactions(); break;
    case 'merch_settlements':   loadMerchSettlements(); break;
    case 'merch_apikeys':       loadMerchApiKeys(); break;
    case 'merch_webhooks':      loadMerchWebhooks(); break;
    case 'merch_profile':       loadMerchProfile(); break;
    case 'agg_transactions':    loadTransactions(); break;
    case 'agg_revenue':         loadAggRevenue(); break;
    case 'agg_merchants':
      apiFetch('/aggregators/my/merchants').then(function(r) {
        var el = document.getElementById('main-content');
        var merchants = (r && r.data) ? r.data : [];
        el.innerHTML =
          '<div class="page-header flex-between">' +
            '<div><div class="page-title">My Merchant Portfolio</div>' +
              '<div class="page-desc">' + merchants.length + ' merchant' + (merchants.length !== 1 ? 's' : '') + '</div></div>' +
            '<button class="btn btn-lime" onclick="navigate(\'agg_onboard\')">+ Onboard Merchant</button>' +
          '</div>' +
          '<div class="card"><div class="table-wrap"><table>' +
            '<thead><tr><th>Business Name</th><th>Category</th><th>KYC Status</th><th>Rate</th><th>Actions</th></tr></thead>' +
            '<tbody>' + (merchants.length ? merchants.map(function(m) {
              var rate = m.processingRate ? (Number(m.processingRate)*100).toFixed(1)+'%' : '—';
              return '<tr>' +
                '<td style="font-weight:500">' + m.businessName + '</td>' +
                '<td><span class="tag">' + (m.category||'—') + '</span></td>' +
                '<td>' + statusBadge(m.kycStatus) + '</td>' +
                '<td class="mono">' + rate + '</td>' +
                '<td>' +
                  '<button class="btn btn-outline btn-sm" onclick="viewMerchant(\'' + m.id + '\')">View</button>&nbsp;' +
                  '<button class="btn btn-outline btn-sm" onclick="editMerchant(\'' + m.id + '\')">&#9998; Edit</button>' +
                '</td>' +
              '</tr>';
            }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px">No merchants yet — onboard your first merchant</td></tr>') +
            '</tbody>' +
          '</table></div></div>';
      });
      break;
    default:
      document.getElementById('main-content').innerHTML = '<div class="page-header"><div class="page-title">' + page + '</div></div><div class="card"><div class="info-box">This section is coming soon.</div></div>';
  }
}

// ── FIRST-TIME PASSWORD (forced change before any access) ─────────────────────
function forceFirstTimePasswordChange() {
  var ip = 'width:100%;padding:11px;border:1.5px solid #cbd5e1;border-radius:8px;margin-bottom:10px;font-size:14px;box-sizing:border-box';
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;background:#0f172a;display:flex;align-items:center;justify-content:center;padding:20px;font-family:DM Sans,sans-serif">' +
      '<div style="background:#fff;border-radius:12px;max-width:420px;width:100%;padding:28px">' +
        '<div style="font-size:18px;font-weight:700;color:#1a2744;margin-bottom:6px">Set your password</div>' +
        '<div style="font-size:13px;color:#64748b;margin-bottom:18px">For your security you must replace your temporary password before continuing.</div>' +
        '<div id="fp-alert" style="display:none;background:#fee2e2;color:#991b1b;border-radius:8px;padding:10px;font-size:13px;margin-bottom:12px"></div>' +
        '<input id="fp-cur" type="password" placeholder="Temporary password" style="' + ip + '">' +
        '<input id="fp-new" type="password" placeholder="New password (min 8 characters)" style="' + ip + '">' +
        '<input id="fp-confirm" type="password" placeholder="Confirm new password" style="' + ip + '">' +
        '<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:#64748b;margin:-2px 0 14px;cursor:pointer"><input type="checkbox" id="fp-show" onclick="togglePwFields(this.checked)" style="cursor:pointer"> Show passwords</label>' +
        '<button id="fp-btn" style="width:100%;padding:12px;background:#1a2744;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer" onclick="submitFirstTimePassword()">Update password &amp; continue</button>' +
        '<div style="text-align:center;margin-top:12px"><a href="#" onclick="sessionStorage.clear();location.href=\'/login.html\';return false" style="font-size:12px;color:#64748b">Sign out</a></div>' +
      '</div></div>';
}
function togglePwFields(show) {
  ['fp-cur','fp-new','fp-confirm'].forEach(function(id){ var e = document.getElementById(id); if (e) e.type = show ? 'text' : 'password'; });
}
async function submitFirstTimePassword() {
  var cur = document.getElementById('fp-cur').value, nw = document.getElementById('fp-new').value, cf = document.getElementById('fp-confirm').value;
  var al = document.getElementById('fp-alert');
  function err(m){ al.textContent = m; al.style.display = 'block'; }
  if (!cur || !nw) return err('Enter your temporary and new password.');
  if (nw.length < 8) return err('New password must be at least 8 characters.');
  if (nw !== cf) return err('New passwords do not match.');
  var btn = document.getElementById('fp-btn'); btn.textContent = 'Updating...'; btn.disabled = true;
  var res = await apiFetch('/auth/change-password', { method:'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
  if (res && res.status) {
    try { var u = getUser(); u.mustChangePassword = false; sessionStorage.setItem('paylode_user', JSON.stringify(u)); } catch(e) {}
    location.reload();
  } else { btn.textContent = 'Update password & continue'; btn.disabled = false; err((res && res.message) || 'Could not update password.'); }
}

// ── LOAD USER INFO IN TOPBAR ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var user = getUser();
  // Wallet members have role MERCHANT but belong to mw_members (no merchant org), so they
  // must use the white-label wallet app — NEVER the merchant portal. Ask the backend
  // authoritatively before doing anything (incl. the temp-password gate), so a member can
  // never be stranded on the merchant dashboard.
  if (user && (user.role || '').toUpperCase() === 'MERCHANT') {
    apiFetch('/wallet/me')
      .then(function(r) {
        if (r && r.status !== false && r.data) {
          // Carry the session across: the wallet app reads localStorage.wallet_token,
          // the portal stored it in sessionStorage.paylode_token. Without this the member
          // would land back on the wallet's login screen (looks like "login does nothing").
          try { var t = sessionStorage.getItem('paylode_token'); if (t) localStorage.setItem('wallet_token', t); } catch (e) {}
          window.location.replace('/wallet.html');
          return;
        }
        continueDashboardBoot(user);
      })
      .catch(function() { continueDashboardBoot(user); });
    return;
  }
  continueDashboardBoot(user);
});

function continueDashboardBoot(user) {
  if (!user) { window.location.href = '/login.html'; return; }
  // First-time password: block the whole dashboard until the temp password is changed.
  if (user.mustChangePassword) { forceFirstTimePasswordChange(); return; }
  if (user.firstName) {
    var initials = (user.firstName[0] + (user.lastName ? user.lastName[0] : '')).toUpperCase();
    var av = document.getElementById('user-avatar');
    if (av) { av.textContent = initials; av.title = ''; }
    var ub = document.getElementById('topbar-user');
    if (ub) ub.textContent = user.firstName + ' ' + (user.lastName || '');
    var mn = document.getElementById('user-menu-email');
    if (mn) mn.textContent = user.email || (user.firstName + ' ' + (user.lastName || ''));
  }
  // Set correct role from JWT — case-insensitive
  var role = (user.role || '').toUpperCase();
  if      (role === 'SUPER_ADMIN')        currentRole = 'superadmin';
  else if (role === 'ADMIN')              currentRole = 'admin';
  else if (role === 'COMPLIANCE_OFFICER') currentRole = 'compliance';
  else if (role === 'AUDIT')              currentRole = 'audit';
  else if (role === 'AGGREGATOR')         currentRole = 'aggregator';
  else if (role === 'MERCHANT')           currentRole = 'merchant';

  // Update role name badge with actual user/company name from JWT
  var roleNameEl = document.getElementById('role-name');
  if (roleNameEl) {
    var displayName = user.businessName || user.companyName || user.organizationName ||
                      (user.firstName ? (user.firstName + ' ' + (user.lastName||'')).trim() : null) ||
                      (currentRole === 'merchant' ? 'My Business' : currentRole === 'aggregator' ? 'My Portfolio' : 'Paylode HQ');
    roleNameEl.textContent = displayName;
  }

  // Hide role switcher for non-superadmin users — merchants and aggregators
  // must not be able to switch to another role's view
  var switcher = document.querySelector('.role-switcher');
  if (switcher && currentRole !== 'superadmin') {
    switcher.style.display = 'none';
  }

  // Navigate to this role's default landing page
  currentPage = (ROLE_META[currentRole] && ROLE_META[currentRole].defaultPage) || 'overview';

  renderNav();
  loadPageData(currentPage);
  checkDeadLetters();
}

// ── PAYOUTS DASHBOARD ─────────────────────────────────────────────────────────
async function loadPayouts() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const [wallet, batches, banks] = await Promise.all([
      apiFetch('/payouts/wallet'),
      apiFetch('/payouts/batches'),
      apiFetch('/payouts/banks'),
    ]);
    const w = wallet?.data || {};
    const batchList = batches?.data || [];
    const bankList  = banks?.data  || [];
    const bankMap   = {};
    bankList.forEach(b => bankMap[b.bank_code] = b.bank_name);

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Payouts</div><div class="page-desc">Send money to your customers and beneficiaries</div></div>
      <div class="flex" style="gap:10px">
        <div class="stat-card" style="padding:12px 20px;min-width:200px">
          <div class="stat-label">Wallet Balance</div>
          <div class="stat-value" style="font-size:20px">${fmtNaira(w.balance||0)}</div>
          <div class="stat-sub">Available for payouts</div>
        </div>
        <button class="btn btn-lime" onclick="showPayoutUpload()">+ New Payout Batch</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><div class="card-title">Payout Batches</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Reference</th><th>Description</th><th>Total Amount</th><th>Items</th><th>Status</th><th>Scheduled</th><th>Actions</th></tr></thead>
        <tbody>
          ${batchList.length ? batchList.map(b=>`<tr>
            <td class="mono" style="font-size:11px">${b.batch_ref}</td>
            <td>${b.description||'—'}</td>
            <td style="font-weight:600">${fmtNaira(b.total_amount)}</td>
            <td>${b.processed_items}/${b.total_items} <span style="color:var(--red)">${b.failed_items>0?'('+b.failed_items+' failed)':''}</span></td>
            <td>${statusBadge(b.status)}</td>
            <td style="font-size:12px">${b.scheduled_at?new Date(b.scheduled_at).toLocaleDateString('en-NG'):'Instant'}</td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="viewBatch('${b.id}')">View</button>
              ${b.failed_items>0?`<button class="btn btn-outline btn-sm" onclick="retryBatch('${b.id}')">Retry Failed</button>`:''}
            </td>
          </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray-400)">No payout batches yet</td></tr>'}
        </tbody>
      </table></div>
    </div>

    <div id="payout-form-area"></div>`;
  } catch(e){ el.innerHTML = errorBox('Failed to load payouts: '+e.message); }
}

async function showPayoutUpload() {
  const banks = await apiFetch('/payouts/banks');
  const bankList = banks?.data || [];
  window._payoutBanks = bankList;   // cached for client-side upload validation
  const formArea = document.getElementById('payout-form-area');
  formArea.innerHTML = `
  <div class="card">
    <div class="card-header"><div class="card-title">Create New Payout Batch</div></div>
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchTab(this,'manual-tab','upload-tab')">Manual Entry</button>
      <button class="tab-btn" onclick="switchTab(this,'upload-tab','manual-tab')">File Upload (Excel/CSV)</button>
    </div>
    <div id="manual-tab">
      <div class="form-grid" style="margin-bottom:16px">
        <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="payout-desc" placeholder="e.g. May salary payments"></div>
        <div class="form-group"><label class="form-label">Schedule (leave blank for instant)</label><input class="form-input" type="datetime-local" id="payout-schedule"></div>
      </div>
      <div id="beneficiary-rows">
        <div class="form-grid beneficiary-row" style="margin-bottom:8px;align-items:end">
          <div class="form-group" style="margin:0"><label class="form-label">Account Number</label><input class="form-input ben-acct" placeholder="10 digits" maxlength="10"></div>
          <div class="form-group" style="margin:0"><label class="form-label">Bank</label>
            <select class="form-input form-select ben-bank">
              <option value="">Select bank</option>
              ${bankList.map(b=>`<option value="${b.bank_code}">${b.bank_name}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0"><label class="form-label">Amount (₦)</label><input class="form-input ben-amount" type="number" placeholder="e.g. 5000"></div>
          <div class="form-group" style="margin:0"><label class="form-label">Narration</label><input class="form-input ben-narration" placeholder="Defaults to 'Payment from ...'"></div>
        </div>
      </div>
      <div class="flex" style="gap:8px;margin-top:8px">
        <button class="btn btn-outline btn-sm" onclick="addBeneficiaryRow()">+ Add Row</button>
        <button class="btn btn-primary" onclick="submitManualPayout()">Submit Payout Batch</button>
      </div>
    </div>
    <div id="upload-tab" style="display:none">
      <div class="info-box" style="margin-bottom:12px;font-size:12px">
        <strong>Required columns:</strong> Bank Name, Account Number, Amount &nbsp;|&nbsp; <strong>Optional:</strong> Narration.
        You don't need bank codes — pick the bank by name and we attach the right code &amp; verify each account before anything is submitted.
        Leave Narration blank and we use &ldquo;Payment from &lt;your business name&gt;&rdquo; automatically.
        <button class="btn btn-outline btn-sm" style="margin-left:8px" onclick="downloadPayoutTemplate()">&#8681; Download Template</button>
      </div>
      <div class="warn-box" style="margin-bottom:12px;font-size:12px">
        &#9888; <strong>Resending failed payouts?</strong> Do NOT re-upload the original file — that pays everyone again.
        Upload a NEW file containing ONLY the failed transactions (open the batch &rarr; "Download failed for resend").
      </div>
      <div class="form-group"><label class="form-label">Upload Excel (.xlsx) or CSV</label>
        <input type="file" accept=".xlsx,.xls,.csv" id="payout-file" class="form-input" onchange="validatePayoutFile(this)">
      </div>
      <div id="payout-validation"></div>
    </div>
  </div>`;
}

function addBeneficiaryRow() {
  const container = document.getElementById('beneficiary-rows');
  const first = container.querySelector('.beneficiary-row');
  const clone = first.cloneNode(true);
  clone.querySelectorAll('input').forEach(i=>i.value='');
  container.appendChild(clone);
}

async function submitManualPayout() {
  const rows = document.querySelectorAll('.beneficiary-row');
  const items = [];
  for (const row of rows) {
    const acct = row.querySelector('.ben-acct').value.trim();
    const bank = row.querySelector('.ben-bank').value;
    const amt  = parseFloat(row.querySelector('.ben-amount').value);
    const nar  = row.querySelector('.ben-narration').value;
    if (!acct || !bank || !amt) continue;
    items.push({ account_number: acct, bank_code: bank, amount: Math.round(amt*100), narration: nar });
  }
  if (!items.length) { alert('Add at least one beneficiary'); return; }
  const desc     = document.getElementById('payout-desc').value;
  const schedule = document.getElementById('payout-schedule').value;
  const res = await apiFetch('/payouts/batches', {
    method: 'POST',
    body: JSON.stringify({ description: desc, scheduled_at: schedule||undefined, items }),
  });
  if (res?.status) { alert(`Payout batch created!\n${res.data.total_items} beneficiaries\n${res.data.total_amount}`); loadPayouts(); }
  else alert('Error: ' + (res?.message||'Failed'));
}

// Download the official payout template (.xlsx) — Bank Name / Account Number /
// Amount / Narration, with a dropdown-validated Bank Name and a 'Bank List' tab.
// Served as a static file so the dropdown + instructions are preserved; falls
// back to client-side generation if the static file isn't reachable.
function downloadPayoutTemplate() {
  var url = '/paylode_payout_template.xlsx?v=2';
  fetch(url).then(function (r) {
    if (!r.ok) throw new Error('not found');
    return r.blob();
  }).then(function (blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'Paylode Payout Template.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
  }).catch(function () {
    // Fallback: build a basic template client-side (no dropdown).
    if (typeof XLSX === 'undefined') { alert('Could not load the template — please try again.'); return; }
    var tmpl = [
      ['Bank Name', 'Account Number', 'Amount (NGN)', "Narration (Optional — blank = 'Payment from <your business name>')"],
      ['OPay', '7030000266', 200, 'Salary June'],
      ['GTBank', '0123456789', 15000, 'Vendor payment'],
      ['Access Bank', '0044556677', 5000, ''],
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(tmpl), 'Payouts');
    var banks = [['Bank Name', 'NIBSS Code (reference only)']].concat((window._payoutBanks || []).map(function (b) { return [b.bank_name, b.bank_code]; }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(banks), 'Bank List');
    XLSX.writeFile(wb, 'Paylode Payout Template.xlsx');
  });
}

// Client-side bank-name → code resolver (mirrors backend src/data/nibssBanks.js).
// Uses the cached /payouts/banks list (window._payoutBanks) + common aliases.
var _BANK_ALIASES = {
  'GTB': 'GTBANK', 'GT BANK': 'GTBANK', 'GUARANTY TRUST': 'GTBANK', 'GUARANTY TRUST BANK': 'GTBANK',
  'UBA': 'UNITED BANK FOR AFRICA', 'FIRST BANK': 'FIRST BANK OF NIGERIA', 'FIRSTBANK': 'FIRST BANK OF NIGERIA',
  'FBN': 'FIRST BANK OF NIGERIA', 'ZENITH': 'ZENITH BANK', 'ACCESS': 'ACCESS BANK',
  'WEMA': 'WEMA BANK', 'ALAT': 'WEMA BANK', 'ALAT BY WEMA': 'WEMA BANK', 'UNION': 'UNION BANK OF NIGERIA',
  'UNION BANK': 'UNION BANK OF NIGERIA', 'STANBIC': 'STANBIC IBTC BANK', 'STANBIC IBTC': 'STANBIC IBTC BANK',
  'POLARIS': 'POLARIS BANK', 'ECOBANK': 'ECOBANK NIGERIA', 'STERLING': 'STERLING BANK',
  'FIDELITY': 'FIDELITY BANK', 'PAYCOM': 'OPAY', 'KUDA': 'KUDA MFB', 'KUDA BANK': 'KUDA MFB',
  'KEYSTONE': 'KEYSTONE BANK', 'PROVIDUS': 'PROVIDUS BANK', 'GLOBUS': 'GLOBUS BANK', 'FCMB': 'FCMB MFB',
};
function _normBank(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function _bankIndex() {
  if (window._payoutBankIdx) return window._payoutBankIdx;
  var byName = {}, byCode = {};
  (window._payoutBanks || []).forEach(function (b) { byName[_normBank(b.bank_name)] = b; byCode[String(b.bank_code)] = b; });
  window._payoutBankIdx = { byName: byName, byCode: byCode };
  return window._payoutBankIdx;
}
// returns { bank_code, bank_name } or null
function resolveBankName(input) {
  if (input == null || String(input).trim() === '') return null;
  var raw = String(input).trim(), idx = _bankIndex();
  if (idx.byCode[raw]) return { bank_code: idx.byCode[raw].bank_code, bank_name: idx.byCode[raw].bank_name };
  var n = _normBank(raw);
  if (idx.byName[n]) return { bank_code: idx.byName[n].bank_code, bank_name: idx.byName[n].bank_name };
  if (_BANK_ALIASES[n] && idx.byName[_BANK_ALIASES[n]]) {
    var b = idx.byName[_BANK_ALIASES[n]]; return { bank_code: b.bank_code, bank_name: b.bank_name };
  }
  return null;
}

// Parse + validate an uploaded Excel/CSV BEFORE anything is submitted.
function validatePayoutFile(input) {
  var file = input.files[0]; if (!file) return;
  var out = document.getElementById('payout-validation');
  if (typeof XLSX === 'undefined') { out.innerHTML = '<div class="warn-box" style="font-size:12px">Excel library still loading — try again.</div>'; return; }
  out.innerHTML = loading();
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var wb = XLSX.read(e.target.result, { type: 'array' });
      // Use the 'Payouts' sheet if present (our template has Instructions/Bank List
      // tabs too); otherwise fall back to the first non-reference sheet.
      var skip = { 'instructions': 1, 'bank list': 1, 'bank codes': 1, 'banks': 1 };
      var sheetName = wb.SheetNames.filter(function (n) { return n.toLowerCase() === 'payouts'; })[0]
        || wb.SheetNames.filter(function (n) { return !skip[n.toLowerCase()]; })[0]
        || wb.SheetNames[0];
      var ws = wb.Sheets[sheetName];
      var rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
      runPayoutValidation(rows);
    } catch (err) { out.innerHTML = '<div class="warn-box" style="font-size:12px">Could not read the file: ' + err.message + '</div>'; }
  };
  reader.readAsArrayBuffer(file);
}

function _normKey(k) { return String(k).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function runPayoutValidation(rawRows) {
  var out = document.getElementById('payout-validation');
  var bankCodes = {}; (window._payoutBanks || []).forEach(function (b) { bankCodes[String(b.bank_code)] = b.bank_name; });
  // map header synonyms -> canonical
  var syn = {
    account_number: ['accountnumber', 'account', 'accountno', 'acct', 'acctno', 'nuban'],
    bank: ['bankname', 'bank', 'bankcode', 'code'],
    amount: ['amount', 'amountngn', 'amountnaira', 'amount_naira', 'amt', 'value'],
    narration: ['narration', 'narrationoptional', 'description', 'remark', 'reference', 'note'],
    account_name: ['accountname', 'name', 'beneficiary', 'beneficiaryname'],
  };
  function pick(row, canon) {
    for (var k in row) { var nk = _normKey(k); if (nk === canon || (syn[canon] && syn[canon].indexOf(nk) !== -1)) return row[k]; }
    return '';
  }
  if (!rawRows.length) { out.innerHTML = '<div class="warn-box" style="font-size:12px">The file has no data rows.</div>'; return; }

  var errors = [], items = [], seen = {}, total = 0;
  rawRows.forEach(function (row, idx) {
    var line = idx + 2; // +1 header, +1 to 1-index
    var acctRaw = pick(row, 'account_number');
    var bankRaw = String(pick(row, 'bank') || '').trim();
    var amtRaw = pick(row, 'amount');
    var narr = String(pick(row, 'narration') || '').trim();
    var name = String(pick(row, 'account_name') || '').trim();
    var acct = String(acctRaw == null ? '' : acctRaw).replace(/\D/g, '');
    // skip fully blank rows silently
    if (!acct && !bankRaw && (amtRaw === '' || amtRaw == null)) return;

    var rowErrs = [];
    if (acct.length !== 10) rowErrs.push('Account Number must be exactly 10 digits');
    // Resolve the merchant-supplied Bank NAME (or code) to a canonical code.
    var resolved = bankRaw ? resolveBankName(bankRaw) : null;
    var bankCode = '', bankName = '';
    if (!bankRaw) rowErrs.push('Bank Name is missing');
    else if (!resolved) rowErrs.push('bank "' + bankRaw + '" was not recognised — pick a name from the Bank List tab');
    else { bankCode = resolved.bank_code; bankName = resolved.bank_name; }
    var amt = parseFloat(amtRaw);
    if (isNaN(amt) || amt <= 0) rowErrs.push('Amount must be a number greater than 0');
    else if (amt > 10000000) rowErrs.push('amount ₦' + amt.toLocaleString() + ' looks unusually large — please confirm');

    var key = acct + '|' + bankCode + '|' + amt;
    if (!rowErrs.length && seen[key]) rowErrs.push('duplicate of row ' + seen[key] + ' (same account, bank & amount)');
    if (!seen[key]) seen[key] = line;

    if (rowErrs.length) errors.push({ line: line, msgs: rowErrs });
    else { items.push({ account_number: acct, bank_code: bankCode, bank_name: bankName, amount: Math.round(amt * 100), narration: narr, account_name: name }); total += amt; }
  });

  window._payoutValidItems = items;
  var html = '';
  if (errors.length) {
    html += '<div class="warn-box" style="margin:12px 0;font-size:12px"><strong>' + errors.length + ' row(s) have errors — fix them and re-upload. Nothing has been submitted.</strong></div>';
    html += '<div class="table-wrap"><table style="width:100%"><thead><tr><th>Row</th><th>Issue(s)</th></tr></thead><tbody>' +
      errors.slice(0, 100).map(function (e) { return '<tr><td>' + e.line + '</td><td style="font-size:12px;color:var(--red)">' + e.msgs.join('; ') + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
    if (items.length) html += '<div class="info-box" style="margin-top:10px;font-size:12px">' + items.length + ' valid row(s) found, but the batch is blocked until all errors are fixed.</div>';
  } else {
    html += '<div class="info-box" style="margin:12px 0;font-size:13px;background:#f0fdf4;border-color:#bbf7d0;color:#166534">' +
      '&#10003; ' + items.length + ' beneficiaries validated — total ₦' + total.toLocaleString('en-NG') + '. ' +
      'Confirm the matched banks below — the account name is verified by the bank before any money is sent.</div>';
    html += '<div class="table-wrap" style="max-height:280px;overflow:auto"><table style="width:100%;font-size:12px"><thead><tr>' +
      '<th>#</th><th>Account Number</th><th>Bank (matched)</th><th style="text-align:right">Amount (₦)</th><th>Narration</th></tr></thead><tbody>' +
      items.slice(0, 200).map(function (it, i) {
        return '<tr><td>' + (i + 1) + '</td><td>' + it.account_number + '</td><td>' + (it.bank_name || it.bank_code) +
          '</td><td style="text-align:right">' + (it.amount / 100).toLocaleString('en-NG') + '</td><td>' + (it.narration || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (items.length > 200 ? '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">Showing first 200 of ' + items.length + ' rows.</div>' : '');
    html += '<div class="form-grid" style="grid-template-columns:1fr;gap:8px;margin:10px 0 8px"><input class="form-input" id="upload-desc" placeholder="Batch description (optional)"></div>' +
      '<button class="btn btn-primary" onclick="submitValidatedPayout()">Confirm &amp; Submit ' + items.length + ' Payouts</button>';
  }
  out.innerHTML = html;
}

async function submitValidatedPayout() {
  var items = window._payoutValidItems || [];
  if (!items.length) { alert('No validated rows to submit.'); return; }
  var desc = (document.getElementById('upload-desc') || {}).value || '';
  var res = await apiFetch('/payouts/batches', { method: 'POST', body: JSON.stringify({ description: desc, items: items }) });
  if (res && res.status) { alert('Payout received — ' + res.data.total_items + ' beneficiaries.'); loadPayouts(); }
  else alert('Error: ' + ((res && res.message) || 'Failed'));
}

async function viewBatch(id) {
  const res = await apiFetch(`/payouts/batches/${id}`);
  if (!res?.data) return;
  const { batch, items } = res.data;
  window._viewBatchItems = items;   // for "download failed for resend"
  const el = document.getElementById('main-content');

  const feeInfo = (batch.total_fee_naira > 0 || batch.total_vat_naira > 0)
    ? `<div class="warn-box" style="margin-bottom:16px;font-size:13px">
        <strong>Fee breakdown:</strong> &nbsp;
        Payouts: <strong>${fmtNaira(batch.total_amount)}</strong> &nbsp;+&nbsp;
        Service fee (${batch.fee_rate_pct||'0%'}): <strong>${fmtNaira((batch.total_fee_naira||0)*100)}</strong> &nbsp;+&nbsp;
        VAT (7.5%): <strong>${fmtNaira((batch.total_vat_naira||0)*100)}</strong> &nbsp;=&nbsp;
        Total deducted: <strong>${fmtNaira((batch.total_deducted_naira||0)*100)}</strong>
      </div>`
    : '';

  el.innerHTML = `
  <div class="page-header flex-between">
    <div><div class="page-title">Payout Batch — ${batch.batch_ref}</div><div class="page-desc">${batch.description||''}</div></div>
    <div class="flex" style="gap:8px">
      ${statusBadge(batch.status)}
      <button class="btn btn-outline btn-sm" onclick="loadPayouts()">← Back</button>
    </div>
  </div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Payout</div><div class="stat-value">${fmtNaira(batch.total_amount)}</div><div class="stat-sub">To beneficiaries</div></div>
    <div class="stat-card"><div class="stat-label">Fee + VAT</div><div class="stat-value" style="font-size:18px">${fmtNaira(((batch.total_fee_naira||0)+(batch.total_vat_naira||0))*100)}</div><div class="stat-sub">${batch.fee_rate_pct||'0%'} + 7.5% VAT</div></div>
    <div class="stat-card"><div class="stat-label">Processed</div><div class="stat-value" style="color:var(--green)">${batch.processed_items}</div><div class="stat-sub">of ${batch.total_items}</div></div>
    <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:var(--red)">${batch.failed_items}</div><div class="stat-sub">${batch.failed_items > 0 ? 'See reasons below' : 'None'}</div></div>
  </div>
  ${feeInfo}
  ${batch.failed_items > 0 ? `<div class="warn-box" style="margin-bottom:12px;font-size:12px">&#9888; <strong>${batch.failed_items} payout(s) failed.</strong> To resend, click "Download failed for resend" and upload that file as a NEW batch — do NOT re-upload the original file (that would pay the successful beneficiaries again).</div>` : ''}
  <div class="card">
    <div class="card-header"><div class="card-title">Payout Items</div>
      ${batch.failed_items > 0 ? `<button class="btn btn-lime btn-sm" onclick="downloadFailedForResend()">&#8681; Download failed for resend</button>` : ''}
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Account</th><th>Bank</th><th>Amount</th><th>Fee</th><th>VAT</th><th>Narration</th><th>Status</th><th>Failure Reason</th></tr></thead>
      <tbody>
        ${items.map(i=>`<tr>
          <td class="mono" style="font-size:12px">${i.account_number}${i.account_name?'<br><span style="color:var(--gray-400);font-size:11px">'+i.account_name+'</span>':''}</td>
          <td style="font-size:12px">${i.bank_name||i.bank_code}</td>
          <td style="font-weight:600">${fmtNaira(i.amount)}</td>
          <td class="mono" style="font-size:12px;color:var(--amber)">${i.fee_naira > 0 ? fmtNaira(i.fee_naira*100) : '—'}</td>
          <td class="mono" style="font-size:12px;color:var(--gray-500)">${i.vat_naira > 0 ? fmtNaira(i.vat_naira*100) : '—'}</td>
          <td style="font-size:12px">${i.narration||'—'}</td>
          <td>${statusBadge(i.status)}</td>
          <td style="font-size:12px;color:var(--red);max-width:200px">${i.failure_reason||'—'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

async function retryBatch(id) {
  if (!confirm('Retry all failed items in this batch?')) return;
  const res = await apiFetch(`/payouts/batches/${id}/retry-failed`, { method:'POST' });
  if (res?.status) { alert(`${res.data.retried} items requeued`); loadPayouts(); }
}

// Export ONLY the failed items in template format so the merchant can re-upload
// them as a NEW batch (never re-upload the original file).
function downloadFailedForResend() {
  if (typeof XLSX === 'undefined') { alert('Excel library still loading — try again.'); return; }
  var failed = (window._viewBatchItems || []).filter(function (i) { return i.status === 'failed'; });
  if (!failed.length) { alert('No failed items to export.'); return; }
  var aoa = [['account_number', 'bank_code', 'amount', 'narration', 'account_name']];
  failed.forEach(function (i) {
    aoa.push([i.account_number, i.bank_code, Number(i.amount) / 100, i.narration || '', i.account_name || '']);
  });
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Payouts');
  XLSX.writeFile(wb, 'Failed payouts for resend.xlsx');
}

// ── RAIL MANAGEMENT ───────────────────────────────────────────────────────────
// SA: Service Providers = the SCREENING / verification / AML vendors we pay
// (NOT rails — rails live in Rail Configuration).
async function loadServiceProviders() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const res = await apiFetch('/rails/providers-overview');
    const d = res?.data || { screening: [] };
    const svc = s => Array.isArray(s.services) ? s.services.join(', ') : (s.services || '');
    const screenRows = (d.screening || []).map(s =>
      `<tr style="border-bottom:1px solid var(--gray-100)">
        <td style="padding:8px;font-weight:500">${s.name}</td><td style="padding:8px;font-size:12px">${s.type||''}</td>
        <td style="padding:8px;font-size:12px">${svc(s)}</td>
        <td style="padding:8px;font-weight:500">${s.cost||''}</td>
        <td style="padding:8px;font-size:11px;color:var(--gray-500)">${s.status||''}</td>
        <td style="padding:8px">${s.id?`<button class="btn btn-outline btn-sm" style="color:#fff;background:var(--red);border-color:var(--red)" onclick="deleteServiceProvider('${s.id}','${(s.name||'').replace(/'/g,'')}')">Delete</button>`:''}</td></tr>`).join('');
    el.innerHTML = `
      <div class="page-header flex-between"><div><div class="page-title">Service Providers</div>
        <div class="page-desc">Screening, verification &amp; AML vendors we pay (KYC, sanctions/PEP). Payment rails are managed under <strong>Rail Configuration</strong>. Internal only — never shown to merchants.</div></div>
        <button class="btn btn-primary" onclick="showAddServiceProvider()">+ Add Provider</button></div>
      <div class="card"><div class="table-wrap"><table style="width:100%"><thead><tr><th>Provider</th><th>Type</th><th>Services</th><th>Cost</th><th>Status</th><th></th></tr></thead><tbody>${screenRows||'<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--gray-400)">No providers yet — click Add Provider</td></tr>'}</tbody></table></div></div>`;
  } catch (e) { el.innerHTML = errorBox('Failed to load service providers: ' + e.message); }
}
function showAddServiceProvider() {
  showModal(
    `<div class="modal-header"><div class="modal-title">Add Service Provider</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="form-group"><label class="form-label">Provider name *</label><input class="form-input" id="sp-name" placeholder="e.g. Dojah"></div>
     <div class="form-group"><label class="form-label">Type</label><input class="form-input" id="sp-type" placeholder="e.g. KYC / Identity, AML screening"></div>
     <div class="form-group"><label class="form-label">Services</label><input class="form-input" id="sp-services" placeholder="e.g. BVN, NIN, CAC, Address"></div>
     <div class="form-grid">
       <div class="form-group"><label class="form-label">Cost</label><input class="form-input" id="sp-cost" placeholder="e.g. ₦50 per check / TBD"></div>
       <div class="form-group"><label class="form-label">Status</label><input class="form-input" id="sp-status" placeholder="e.g. active / KIV"></div>
     </div>
     <div class="flex-between" style="margin-top:8px">
       <button class="btn btn-outline" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
       <button class="btn btn-lime" id="sp-btn" onclick="submitServiceProvider()">Add Provider</button></div>
     <div id="sp-msg" style="margin-top:8px"></div>`);
}
async function submitServiceProvider() {
  const name = document.getElementById('sp-name').value.trim();
  if (!name) { document.getElementById('sp-msg').innerHTML = '<div class="warn-box" style="font-size:12px">Provider name is required.</div>'; return; }
  const body = { name, type: document.getElementById('sp-type').value.trim(),
    services: document.getElementById('sp-services').value.trim(),
    cost: document.getElementById('sp-cost').value.trim(), status: document.getElementById('sp-status').value.trim() };
  const res = await apiFetch('/rails/service-providers', { method:'POST', body: JSON.stringify(body) });
  if (res?.status) { document.getElementById('modal').style.display='none'; loadServiceProviders(); }
  else document.getElementById('sp-msg').innerHTML = '<div class="warn-box" style="font-size:12px">'+((res&&res.message)||'Failed')+'</div>';
}
async function deleteServiceProvider(id, name) {
  if (!confirm('Delete service provider "' + name + '"?')) return;
  const res = await apiFetch('/rails/service-providers/' + id, { method:'DELETE' });
  if (res?.status) { alert(name + ' deleted.'); loadServiceProviders(); }
  else alert((res && res.message) || 'Delete failed');
}

// SA: delete a rail (backend refuses if it's in use or holds float).
async function deleteRail(id, name) {
  if (!confirm('Delete rail "' + name + '"?\n\nAllowed only if it has no disbursements, payout items, transactions, wallets or float balance.')) return;
  const res = await apiFetch('/rails/' + id, { method:'DELETE' });
  if (res?.status) { alert(name + ' deleted.'); loadRails(); }
  else alert((res && res.message) || 'Delete failed');
}

async function loadRails() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const [rails, types, overview] = await Promise.all([
      apiFetch('/rails'),
      apiFetch('/rails/service-types'),
      apiFetch('/rails/providers-overview'),
    ]);
    const railList = rails?.data || [];
    const typeList = types?.data || [];
    const catalogByName = {};
    ((overview?.data && overview.data.rails) || []).forEach(r => { catalogByName[r.name.toLowerCase()] = r; });

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Rail Configuration</div><div class="page-desc">Rails, the products/services they offer us and their price to us (our cost), fee caps and VAT. Internal only.</div></div>
      <button class="btn btn-primary" onclick="showAddRail()">+ Add Rail</button>
    </div>
    <div id="rail-form-area"></div>
    ${railList.map(rail=>`
    <div class="card" style="margin-bottom:12px">
      <div class="card-header">
        <div>
          <div class="card-title">${rail.name}</div>
          <div class="card-subtitle">ID: <span class="mono">${rail.id}</span></div>
        </div>
        <div class="flex" style="gap:8px">
          ${statusBadge(rail.status?.toLowerCase())}
          <select class="form-input form-select" style="width:130px;font-size:12px" onchange="changeRailStatus('${rail.id}',this.value)">
            <option ${rail.status==='CONFIG_ONLY'?'selected':''} value="CONFIG_ONLY">Config Only</option>
            <option ${rail.status==='TESTING'?'selected':''} value="TESTING">Testing</option>
            <option ${rail.status==='LIVE'?'selected':''} value="LIVE">Live</option>
          </select>
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Service Type</th><th>Rate</th><th>Flat Fee</th><th>Max Cap</th><th>Min Charge</th><th>VAT</th><th>Actions</th></tr></thead>
        <tbody>
          ${(rail.costs||[]).length ? rail.costs.map(c=>`<tr>
            <td><span class="tag">${(c.service_type||'—').replace(/_/g,' ')}</span></td>
            <td class="mono">${Number(c.rate||0)>0?(Number(c.rate)*100).toFixed(3)+'%':'—'}</td>
            <td>${Number(c.flat_fee||0)>0?fmtNaira(c.flat_fee):'—'}</td>
            <td>${Number(c.cap||0)>0?fmtNaira(c.cap):'No cap'}</td>
            <td>${Number(c.min_charge||0)>0?fmtNaira(c.min_charge):'—'}</td>
            <td>${(Number(c.vat_rate||0.075)*100).toFixed(1)}%</td>
            <td><button class="btn btn-outline btn-sm" onclick="editRailCost('${rail.id}','${c.service_type}',${c.rate},${c.flat_fee||0},${c.cap||0},${c.min_charge||0},${c.vat_rate||0.075})">Edit</button></td>
          </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:12px">No costs configured — click Add Service Type</td></tr>'}
        </tbody>
      </table></div>
      ${(catalogByName[(rail.name||'').toLowerCase()]?.products||[]).length ? `<div style="margin-top:12px;background:#f8fafc;border:1px solid var(--gray-100);border-radius:8px;padding:10px 12px">
        <div style="font-size:11px;font-weight:600;color:var(--gray-500);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Agreed pricing — their price to us (2026 fee sheet · reference)</div>
        ${catalogByName[(rail.name||'').toLowerCase()].products.map(p=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span>${p.product}</span><span style="font-weight:500">${p.cost}</span></div>`).join('')}
      </div>`:''}
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="showAddServiceType('${rail.id}')">+ Add Service Type</button>
        <button class="btn btn-outline btn-sm" onclick="testRouting('${rail.id}')">Test Routing</button>
        <button class="btn btn-outline btn-sm" style="color:#fff;background:var(--red);border-color:var(--red);margin-left:auto" onclick="deleteRail('${rail.id}','${(rail.name||'').replace(/'/g,'')}')">&#128465; Delete Rail</button>
      </div>
    </div>`).join('')}`;
  } catch(e){ el.innerHTML = errorBox('Failed to load rails: '+e.message); }
}

function showAddRail() {
  document.getElementById('rail-form-area').innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="card-title" style="margin-bottom:12px">Add New Rail</div>
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Rail Name</label><input class="form-input" id="new-rail-name" placeholder="e.g. Interswitch, NIBSS, GTBank"></div>
      <div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="new-rail-notes" placeholder="Optional notes"></div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="submitAddRail()">Create Rail</button>
  </div>`;
}

async function submitAddRail() {
  const name  = document.getElementById('new-rail-name').value.trim();
  const notes = document.getElementById('new-rail-notes').value.trim();
  if (!name) { alert('Rail name required'); return; }
  const res = await apiFetch('/rails', { method:'POST', body: JSON.stringify({ name, notes }) });
  if (res?.status) { alert('Rail created'); loadRails(); }
  else alert('Error: ' + (res?.message||'Failed'));
}

var _RAIL_SVC_TYPES = ['VISA','MASTERCARD','VERVE','BANK_TRANSFER','VIRTUAL_ACCOUNT','PAY_WITH_TRANSFER','PAY_WITH_WALLET','USSD','PAYOUT'];
// Shared cost form. A cost = % rate and/or flat ₦, with optional max cap / min charge.
// rate/vat shown as % (e.g. 1.5); money as ₦. type fixed on edit.
function _railCostForm(railId, isEdit, type, ratePct, flatN, capN, minN, vatPct) {
  var typeField = isEdit
    ? '<input type="hidden" id="st-type" value="' + type + '"><div class="form-group"><label class="form-label">Service Type</label><div style="font-weight:600">' + type.replace(/_/g,' ') + '</div></div>'
    : '<div class="form-group"><label class="form-label">Service Type</label><select class="form-input form-select" id="st-type">' +
        _RAIL_SVC_TYPES.map(function(t){return '<option value="'+t+'">'+t.replace(/_/g,' ')+'</option>';}).join('') + '</select></div>';
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">' + (isEdit ? 'Edit Cost' : 'Add Service Type') + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="font-size:12px;margin-bottom:10px">This is the rail\'s <strong>price to us</strong> for this product. Enter a <strong>% rate</strong>, a <strong>flat ₦ fee</strong>, or both. Cap/Min are optional (blank or 0 = none).</div>' +
    typeField +
    '<div class="form-grid">' +
    '<div class="form-group"><label class="form-label">Percentage rate (%)</label><input class="form-input" id="st-rate" type="number" step="0.001" placeholder="e.g. 1.5" value="' + (ratePct||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">Flat fee (₦)</label><input class="form-input" id="st-flat" type="number" step="0.01" placeholder="e.g. 12" value="' + (flatN||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">Max cap (₦, blank = none)</label><input class="form-input" id="st-cap" type="number" placeholder="e.g. 600" value="' + (capN||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">Min charge (₦, blank = none)</label><input class="form-input" id="st-min" type="number" value="' + (minN||'') + '"></div>' +
    '<div class="form-group"><label class="form-label">VAT (%)</label><input class="form-input" id="st-vat" type="number" step="0.1" value="' + (vatPct!=null?vatPct:7.5) + '"></div>' +
    '</div>' +
    '<div class="flex-between" style="margin-top:4px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-primary" onclick="submitServiceType(\'' + railId + '\')">' + (isEdit ? 'Update' : 'Add') + '</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}
function showAddServiceType(railId) { _railCostForm(railId, false, '', '', '', '', '', 7.5); }
function editRailCost(railId, type, rate, flat, cap, min, vat) {
  _railCostForm(railId, true, type, (Number(rate)*100)||'', (Number(flat)/100)||'', (Number(cap)/100)||'', (Number(min)/100)||'', (Number(vat)*100)||7.5);
}
async function submitServiceType(railId) {
  var ratePct = parseFloat(document.getElementById('st-rate').value) || 0;
  var flat    = parseFloat(document.getElementById('st-flat').value) || 0;
  var cap     = parseFloat(document.getElementById('st-cap').value) || 0;
  var minc    = parseFloat(document.getElementById('st-min').value) || 0;
  var vatPct  = parseFloat(document.getElementById('st-vat').value);
  var type    = document.getElementById('st-type').value;
  if (ratePct <= 0 && flat <= 0) { alert('Enter a percentage rate, a flat fee, or both.'); return; }
  var res = await apiFetch('/rails/' + railId + '/costs', { method:'PUT', body: JSON.stringify({
    service_type: type, rate: ratePct/100, flat_fee: Math.round(flat*100),
    cap: Math.round(cap*100), min_charge: Math.round(minc*100), vat_rate: isNaN(vatPct)?0.075:vatPct/100,
  })});
  if (res?.status) { document.getElementById('modal').style.display = 'none'; loadRails(); }
  else alert('Error: ' + (res?.message||'Failed'));
}

async function changeRailStatus(id, status) {
  const res = await apiFetch(`/rails/${id}/status`, { method:'PUT', body: JSON.stringify({ status }) });
  if (!res?.status) alert('Error: ' + (res?.message||'Failed'));
  else loadRails();
}

async function testRouting() {
  const type   = prompt('Service type (VISA/MASTERCARD/VERVE/BANK_TRANSFER/USSD/PAYOUT):');
  const amount = prompt('Amount in naira:');
  if (!type || !amount) return;
  const res = await apiFetch('/rails/routing-test', {
    method: 'POST',
    body: JSON.stringify({ service_type: type.toUpperCase(), amount: Math.round(parseFloat(amount)*100) }),
  });
  if (res?.status) {
    const d = res.data;
    let msg = `Recommended rail: ${d.recommended_rail}\n\nAll rails:\n`;
    (d.comparison||[]).forEach(r => msg += `${r.rail_name}: ${r.cost_with_vat} (${r.rate_pct}${r.cap_applied?' — cap applied':''})\n`);
    alert(msg);
  } else alert('Error: ' + (res?.message||'No live rails'));
}

// ── WALLET MANAGEMENT (Super Admin) ───────────────────────────────────────────
var __payoutRails = [];   // cached for the fund droplist
async function loadWallets() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const [wRes, rRes, qRes] = await Promise.all([
      apiFetch('/payouts/admin/wallets'),
      apiFetch('/payouts/admin/payout-rails'),
      apiFetch('/payouts/admin/routing-queue'),
    ]);
    const wallets = wRes?.data || [];
    __payoutRails = rRes?.data || [];
    const queue = qRes?.data || [];
    const enabledCount = __payoutRails.filter(r => r.payoutEnabled && r.status === 'LIVE').length;

    window.__merchantRails = {};
    const rows = wallets.length ? wallets.map(w => {
      window.__merchantRails[w.merchant_id] = w.rails || [];
      const railBits = (w.rails||[]).length
        ? (w.rails||[]).map(r => `${r.rail_name}: <strong>${fmtNaira(r.balance)}</strong>`).join(' · ')
        : '<span style="color:var(--gray-400)">no rail funded</span>';
      return `<tr>
        <td style="font-weight:500">${w.business_name}<div class="mono" style="font-size:11px;color:var(--gray-400)">${w.merchant_code||''}</div></td>
        <td style="font-weight:600;color:${w.total>0?'var(--green)':'var(--gray-400)'}">${fmtNaira(w.total)}<div style="font-size:10px;color:var(--gray-400);font-weight:400">${railBits}</div></td>
        <td><button class="btn btn-lime btn-sm" onclick="fundWallet('${w.merchant_id}','${(w.business_name||'').replace(/'/g,'')}')">Credit / Debit</button>
        <button class="btn btn-outline btn-sm" onclick="rebalanceWallet('${w.merchant_id}','${(w.business_name||'').replace(/'/g,'')}')">Rebalance</button>
        <button class="btn btn-outline btn-sm" onclick="viewLedger('${w.merchant_id}')">Ledger</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--gray-400)">No merchant balances yet</td></tr>';

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Merchant Balances</div><div class="page-desc">Each merchant pre-funds payouts PER RAIL (the bank/rail we told them to fund). Rails &amp; our float are internal — merchants only ever see their single total.</div></div>
      <div class="flex" style="gap:6px">
        <button class="btn btn-outline btn-sm" onclick="managePayoutRails()">Rail Floats &amp; Status</button>
        <button class="btn btn-outline btn-sm" onclick="loadPendingRebalances()">Pending Transfers</button>
        <button class="btn btn-outline btn-sm" onclick="loadRoutingQueue()">Routing Queue${queue.length?` <span class="badge badge-amber">${queue.length}</span>`:''}</button>
      </div>
    </div>
    ${queue.length ? `<div class="info-box" style="margin-bottom:14px;font-size:12px">${queue.length} payout(s) awaiting your rail-routing decision. Open <strong>Routing Queue</strong>.</div>` : ''}
    <div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Merchant</th><th>Balance</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
  } catch(e){ el.innerHTML = errorBox('Failed: '+e.message); }
}

function fundWallet(merchantId, name) {
  const rails = (window.__payoutRails||[]).filter(r => r.payoutEnabled);
  const railOpts = rails.map(r => `<option value="${r.id}">${r.name}${r.status==='LIVE'?'':' ('+r.status+')'}</option>`).join('');
  showModal(
    `<div class="modal-header"><div class="modal-title">Credit / Debit — ${name}</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="info-box" style="font-size:12px;margin-bottom:12px">Credit a rail <strong>after</strong> you confirm the merchant's deposit landed in the bank/rail you told them to fund. Payouts draw from the rail they funded. To fund a split, apply once per rail.</div>
     <div class="form-grid">
       <div class="form-group"><label class="form-label">Rail / bank funded *</label>
         <select class="form-input form-select" id="fw-rail">${railOpts||'<option value="">No payout-enabled rail</option>'}</select></div>
       <div class="form-group"><label class="form-label">Direction</label>
         <select class="form-input form-select" id="fw-dir"><option value="credit">Credit (add)</option><option value="debit">Debit (remove)</option></select></div>
     </div>
     <div class="form-group"><label class="form-label">Amount (₦) *</label><input class="form-input" id="fw-amt" type="number" min="1" placeholder="e.g. 500000"></div>
     <div class="form-group"><label class="form-label">Reference *</label><input class="form-input" id="fw-ref" placeholder="Bank transfer ref / memo"></div>
     <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="fw-desc" placeholder="Optional note"></div>
     <div class="flex-between" style="margin-top:8px">
       <button class="btn btn-outline" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
       <button class="btn btn-lime" id="fw-btn" onclick="submitFundWallet('${merchantId}','${name}')">Apply</button></div>
     <div id="fw-msg" style="margin-top:8px"></div>`);
}
async function submitFundWallet(merchantId, name) {
  const railId = document.getElementById('fw-rail').value;
  const dir = document.getElementById('fw-dir').value;
  const amt = parseFloat(document.getElementById('fw-amt').value);
  const reference = (document.getElementById('fw-ref').value||'').trim();
  const description = (document.getElementById('fw-desc').value||'').trim();
  const msg = document.getElementById('fw-msg');
  if (!railId) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Pick the rail the merchant funded.</div>'; return; }
  if (!amt || amt <= 0 || !reference) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Amount and reference are required.</div>'; return; }
  const btn = document.getElementById('fw-btn'); btn.disabled = true; btn.textContent = 'Applying...';
  const res = await apiFetch('/payouts/wallet/fund', { method:'POST', body: JSON.stringify({
    merchant_id: merchantId, rail_id: railId, direction: dir, amount: Math.round(amt*100), reference, description,
  })});
  if (res?.status) { document.getElementById('modal').style.display='none'; loadWallets(); }
  else { msg.innerHTML = '<div class="warn-box" style="font-size:12px">'+((res&&res.message)||'Failed')+'</div>'; btn.disabled=false; btn.textContent='Apply'; }
}

// SA: move a merchant's pre-funded balance between rails (logical move now + a
// treasury-transfer obligation ops settles when the money physically moves banks).
function rebalanceWallet(merchantId, name) {
  const mr = (window.__merchantRails||{})[merchantId] || [];
  const fromOpts = mr.length
    ? mr.map(r => `<option value="${r.rail_id}">${r.rail_name} — ${fmtNaira(r.balance)}</option>`).join('')
    : '<option value="">No funded rail to move from</option>';
  const toOpts = (window.__payoutRails||[]).filter(r => r.payoutEnabled)
    .map(r => `<option value="${r.id}">${r.name}</option>`).join('');
  showModal(
    `<div class="modal-header"><div class="modal-title">Rebalance — ${name}</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="info-box" style="font-size:12px;margin-bottom:12px">Move this merchant's pre-funded balance from one rail to another. This records the move now and a <strong>pending treasury transfer</strong> — physically move the funds between the rail bank accounts, then mark it settled under <em>Pending Transfers</em>.</div>
     <div class="form-grid">
       <div class="form-group"><label class="form-label">From rail *</label><select class="form-input form-select" id="rb-from">${fromOpts}</select></div>
       <div class="form-group"><label class="form-label">To rail *</label><select class="form-input form-select" id="rb-to">${toOpts||'<option value="">No payout-enabled rail</option>'}</select></div>
     </div>
     <div class="form-group"><label class="form-label">Amount (₦) *</label><input class="form-input" id="rb-amt" type="number" min="1" placeholder="e.g. 100000"></div>
     <div class="form-group"><label class="form-label">Reference / note</label><input class="form-input" id="rb-ref" placeholder="Optional"></div>
     <div class="flex-between" style="margin-top:8px">
       <button class="btn btn-outline" onclick="document.getElementById('modal').style.display='none'">Cancel</button>
       <button class="btn btn-lime" id="rb-btn" onclick="submitRebalance('${merchantId}')">Rebalance</button></div>
     <div id="rb-msg" style="margin-top:8px"></div>`);
}
async function submitRebalance(merchantId) {
  const from = document.getElementById('rb-from').value;
  const to   = document.getElementById('rb-to').value;
  const amt  = parseFloat(document.getElementById('rb-amt').value);
  const ref  = (document.getElementById('rb-ref').value||'').trim();
  const msg  = document.getElementById('rb-msg');
  if (!from || !to) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Pick both rails.</div>'; return; }
  if (from === to) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Choose two different rails.</div>'; return; }
  if (!amt || amt <= 0) { msg.innerHTML = '<div class="warn-box" style="font-size:12px">Enter a positive amount.</div>'; return; }
  const btn = document.getElementById('rb-btn'); btn.disabled = true; btn.textContent = 'Rebalancing...';
  const res = await apiFetch('/payouts/admin/wallet/rebalance', { method:'POST', body: JSON.stringify({
    merchant_id: merchantId, moves: [{ from_rail_id: from, to_rail_id: to, amount: Math.round(amt*100) }], reference: ref || undefined,
  })});
  if (res?.status) { document.getElementById('modal').style.display='none'; loadWallets(); }
  else { msg.innerHTML = '<div class="warn-box" style="font-size:12px">'+((res&&res.message)||'Failed')+'</div>'; btn.disabled=false; btn.textContent='Rebalance'; }
}

// SA: pending treasury-transfer obligations created by rebalances.
async function loadPendingRebalances() {
  const res = await apiFetch('/payouts/admin/wallet/rebalances?status=pending');
  const list = res?.data || [];
  const rows = list.length ? list.map(r => `<tr style="border-bottom:1px solid var(--gray-100)">
    <td style="padding:8px">${r.business_name}<div class="mono" style="font-size:11px;color:var(--gray-400)">${r.reference||''}</div></td>
    <td style="padding:8px;font-size:12px">${r.from_rail} &rarr; ${r.to_rail}</td>
    <td style="padding:8px;font-weight:600">${fmtNaira(r.amount)}</td>
    <td style="padding:8px;font-size:11px;color:var(--gray-400)">${new Date(r.created_at).toLocaleString()}</td>
    <td style="padding:8px"><button class="btn btn-lime btn-sm" onclick="settleRebalance('${r.id}')">Mark Settled</button></td>
  </tr>`).join('') : '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--gray-400)">No pending transfers</td></tr>';
  showModal(
    `<div class="modal-header"><div class="modal-title">Pending Treasury Transfers</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="info-box" style="font-size:12px;margin-bottom:12px">Each row is a rebalance whose funds must be <strong>physically moved between the rail bank accounts</strong>. Mark settled once the transfer lands.</div>
     <div class="table-wrap"><table style="width:100%;border-collapse:collapse"><thead><tr style="border-bottom:2px solid var(--gray-200)">
       <th style="text-align:left;padding:8px">Merchant</th><th style="text-align:left;padding:8px">Move</th><th style="text-align:left;padding:8px">Amount</th><th style="text-align:left;padding:8px">Created</th><th></th></tr></thead>
       <tbody>${rows}</tbody></table></div>`, 'lg');
}
async function settleRebalance(id) {
  const res = await apiFetch('/payouts/admin/wallet/rebalance/'+id+'/settle', { method:'POST' });
  if (res?.status) loadPendingRebalances();
  else alert('Error: '+((res&&res.message)||'Failed'));
}

// SA: enable/disable payout rails + set LIVE status
async function managePayoutRails() {
  const res = await apiFetch('/payouts/admin/payout-rails');
  const rails = res?.data || [];
  window.__railCfg = {};
  const rows = rails.map(r => { window.__railCfg[r.id] = r; return `<tr style="border-bottom:1px solid var(--gray-100)">
    <td style="padding:8px">${r.name}<div style="font-size:10px;color:var(--gray-400)">${r.sponsor_bank||'no sponsor set'}</div></td>
    <td style="padding:8px;font-weight:600;color:${r.float_balance>0?'var(--green)':'var(--gray-400)'}">${fmtNaira(r.float_balance||0)}<div style="font-size:10px;color:var(--gray-400);font-weight:400">${r.float_synced_at?('synced '+new Date(r.float_synced_at).toLocaleString()):'never synced'}</div></td>
    <td style="padding:8px">${r.payout_flat_cost?fmtNaira(r.payout_flat_cost):'<span style="color:var(--gray-400)">—</span>'}<div style="font-size:10px;color:var(--gray-400)">other-bank / transfer</div>${r.payout_flat_cost_onus?('<div style="font-size:11px">'+fmtNaira(r.payout_flat_cost_onus)+'<span style="font-size:10px;color:var(--gray-400)"> on-us</span></div>'):''}</td>
    <td style="padding:8px;font-size:12px">${r.daily_value_cap!=null?(fmtNaira(r.used_today||0)+' / '+fmtNaira(r.daily_value_cap)):'<span style="color:var(--gray-400)">no cap</span>'}${r.tps_limit?'<div style="font-size:10px;color:var(--gray-400)">'+r.tps_limit+' TPS</div>':''}</td>
    <td style="padding:8px"><span class="badge ${r.status==='LIVE'?'badge-green':'badge-gray'}">${r.status}</span> ${r.payoutEnabled?'<span class="badge badge-green">on</span>':'<span class="badge badge-gray">off</span>'}</td>
    <td style="padding:8px;white-space:nowrap">
      <button class="btn btn-lime btn-sm" onclick="editRailConfig('${r.id}')">Config</button>
      <button class="btn btn-outline btn-sm" onclick="syncRailFloat('${r.id}')">&#8635;</button>
      <button class="btn btn-outline btn-sm" onclick="togglePayoutRail('${r.id}','enable',${!r.payoutEnabled})">${r.payoutEnabled?'Disable':'Enable'}</button>
      <button class="btn btn-outline btn-sm" onclick="togglePayoutRail('${r.id}','status','${r.status==='LIVE'?'CONFIG_ONLY':'LIVE'}')">${r.status==='LIVE'?'Config-Only':'Set LIVE'}</button>
    </td></tr>`; }).join('');
  showModal(
    `<div class="modal-header"><div class="modal-title">Rail Floats, Cost &amp; Caps</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="info-box" style="font-size:12px;margin-bottom:12px"><strong>Float</strong> = OUR balance with each rail (auto-polled; &#8635; to refresh). <strong>Cost</strong> = our flat charge per transfer. <strong>Cap</strong> = max value/day to protect the sponsor bank. All internal — never shown to merchants.</div>
     <div class="table-wrap"><table style="width:100%;border-collapse:collapse"><thead><tr style="border-bottom:2px solid var(--gray-200)">
       <th style="text-align:left;padding:8px">Rail / Sponsor</th><th style="text-align:left;padding:8px">Our Float</th><th style="text-align:left;padding:8px">Cost/txn</th><th style="text-align:left;padding:8px">Today / Daily cap</th><th style="text-align:left;padding:8px">State</th><th></th></tr></thead>
       <tbody>${rows||'<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--gray-400)">No rails configured</td></tr>'}</tbody></table></div>`,'lg');
}
// SA: edit a rail's payout config (cost / daily cap / TPS / sponsor bank)
function editRailConfig(id) {
  const r = (window.__railCfg || {})[id] || {};
  showModal(
    `<div class="modal-header"><div class="modal-title">${r.name} — Payout Config</div>
     <button class="modal-close" onclick="managePayoutRails()">&#10005;</button></div>
     <div class="form-group"><label class="form-label">Sponsor bank / switch</label><input class="form-input" id="rc-sponsor" value="${r.sponsor_bank||''}" placeholder="e.g. Wema (sponsor)"></div>
     <div class="form-grid">
       <div class="form-group"><label class="form-label">Cost per transfer — other banks (₦)</label><input class="form-input" id="rc-cost" type="number" min="0" step="0.01" value="${r.payout_flat_cost!=null?(r.payout_flat_cost/100):''}" placeholder="e.g. 12"></div>
       <div class="form-group"><label class="form-label">Cost per transfer — on-us / ${r.name} (₦)</label><input class="form-input" id="rc-cost-onus" type="number" min="0" step="0.01" value="${r.payout_flat_cost_onus!=null?(r.payout_flat_cost_onus/100):''}" placeholder="e.g. 5"></div>
     </div>
     <div class="form-group"><label class="form-label">Daily value cap (₦, blank = none)</label><input class="form-input" id="rc-cap" type="number" min="0" value="${r.daily_value_cap!=null?(r.daily_value_cap/100):''}" placeholder="e.g. 50000000"></div>
     <div class="form-group"><label class="form-label">TPS limit (sends/sec, blank = none)</label><input class="form-input" id="rc-tps" type="number" min="0" value="${r.tps_limit!=null?r.tps_limit:''}" placeholder="from the bank/switch"></div>
     <div class="flex-between" style="margin-top:8px">
       <button class="btn btn-outline" onclick="managePayoutRails()">Back</button>
       <button class="btn btn-lime" id="rc-btn" onclick="saveRailConfig('${id}')">Save Config</button></div>
     <div id="rc-msg" style="margin-top:8px"></div>`);
}
async function saveRailConfig(id) {
  const cost = document.getElementById('rc-cost').value;
  const costOnus = document.getElementById('rc-cost-onus').value;
  const cap  = document.getElementById('rc-cap').value;
  const tps  = document.getElementById('rc-tps').value;
  const sponsor = document.getElementById('rc-sponsor').value.trim();
  const body = {
    payout_flat_cost:      cost === ''     ? 0 : Math.round(parseFloat(cost) * 100),
    payout_flat_cost_onus: costOnus === '' ? 0 : Math.round(parseFloat(costOnus) * 100),
    daily_value_cap:  cap === '' ? null : Math.round(parseFloat(cap) * 100),
    tps_limit:        tps === '' ? null : parseInt(tps, 10),
    sponsor_bank:     sponsor || null,
  };
  const btn = document.getElementById('rc-btn'); btn.disabled = true; btn.textContent = 'Saving...';
  const res = await apiFetch('/payouts/admin/payout-rails/'+id, { method:'PUT', body: JSON.stringify(body) });
  if (res?.status) managePayoutRails();
  else { document.getElementById('rc-msg').innerHTML = '<div class="warn-box" style="font-size:12px">'+((res&&res.message)||'Failed')+'</div>'; btn.disabled=false; btn.textContent='Save Config'; }
}
async function togglePayoutRail(id, kind, val) {
  const body = kind === 'enable' ? { payout_enabled: val } : { status: val };
  const res = await apiFetch('/payouts/admin/payout-rails/'+id, { method:'PUT', body: JSON.stringify(body) });
  if (res?.status) managePayoutRails(); else alert('Error: '+((res&&res.message)||'Failed'));
}
// SA: refresh OUR balance on a rail from its API now
async function syncRailFloat(id) {
  const res = await apiFetch('/payouts/admin/rails/'+id+'/sync-float', { method:'POST' });
  if (res?.status) { alert(res.message||'Float updated.'); managePayoutRails(); }
  else alert((res&&res.message)||'Could not sync this rail.');
}

// SA: routing queue for payouts no single rail could cover
async function loadRoutingQueue() {
  const res = await apiFetch('/payouts/admin/routing-queue');
  const q = res?.data || [];
  const rows = q.length ? q.map(b => `<tr style="border-bottom:1px solid var(--gray-100)">
    <td style="padding:8px">${b.business_name}<div class="mono" style="font-size:11px;color:var(--gray-400)">${b.batch_ref}</div></td>
    <td style="padding:8px;font-weight:600">${fmtNaira(b.total_amount)}<div style="font-size:10px;color:var(--gray-400);font-weight:400">to beneficiaries</div></td>
    <td style="padding:8px;font-size:11px">${(b.rail_floats||[]).map(r=>r.rail_name+': '+fmtNaira(r.balance)).join('<br>')||'—'}</td>
    <td style="padding:8px"><button class="btn btn-lime btn-sm" onclick="routeBatchPrompt('${b.batch_id}',${b.total_amount},${JSON.stringify(b.rail_floats).replace(/"/g,'&quot;')})">Route</button></td>
  </tr>`).join('') : '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--gray-400)">Nothing awaiting routing</td></tr>';
  showModal(
    `<div class="modal-header"><div class="modal-title">Payout Routing Queue</div>
     <button class="modal-close" onclick="document.getElementById('modal').style.display='none'">&#10005;</button></div>
     <div class="info-box" style="font-size:12px;margin-bottom:12px">Each payout is already tied to the rail(s) the merchant pre-funded — <strong>Route</strong> simply disburses it. To change the rail mix, <strong>Rebalance</strong> the merchant's funds first. Our float is shown for reference.</div>
     <div class="table-wrap"><table style="width:100%;border-collapse:collapse"><thead><tr style="border-bottom:2px solid var(--gray-200)">
       <th style="text-align:left;padding:8px">Merchant / Batch</th><th style="text-align:left;padding:8px">Total</th><th style="text-align:left;padding:8px">Our Rail Floats</th><th></th></tr></thead>
       <tbody>${rows}</tbody></table></div>`);
}
async function routeBatchPrompt(batchId, totalKobo, railFloats) {
  // The per-rail split was decided when the merchant created the payout — each item
  // is tied to the rail they pre-funded. Routing just executes that split.
  if (!confirm(`Disburse this payout (${fmtNaira(totalKobo)}) now? Funds go out through the rail(s) the merchant pre-funded.`)) return;
  const res = await apiFetch('/payouts/admin/batches/'+batchId+'/route', { method:'POST', body: JSON.stringify({}) });
  if (res?.status) { alert(res.message||'Routed and processing.'); document.getElementById('modal').style.display='none'; loadWallets(); }
  else alert('Error: '+((res&&res.message)||'Failed'));
}

async function viewLedger(merchantId) {
  const res = await apiFetch(`/payouts/wallet/ledger?merchant_id=${merchantId}`);
  const ledger = res?.data || [];
  const el = document.getElementById('main-content');
  el.innerHTML = `
  <div class="page-header flex-between">
    <div class="page-title">Wallet Ledger</div>
    <button class="btn btn-outline btn-sm" onclick="loadWallets()">← Back</button>
  </div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>Type</th><th>Amount</th><th>Balance Before</th><th>Balance After</th><th>Reference</th><th>Description</th><th>Date</th></tr></thead>
    <tbody>
      ${ledger.map(l=>`<tr>
        <td>${l.entry_type==='CREDIT'?'<span class="badge badge-green">CREDIT</span>':'<span class="badge badge-red">DEBIT</span>'}</td>
        <td style="font-weight:600">${fmtNaira(l.amount)}</td>
        <td>${fmtNaira(l.balance_before)}</td>
        <td>${fmtNaira(l.balance_after)}</td>
        <td class="mono" style="font-size:11px">${l.reference}</td>
        <td style="font-size:12px">${l.description||'—'}</td>
        <td style="font-size:12px">${new Date(l.created_at).toLocaleDateString('en-NG')}</td>
      </tr>`).join('')}
    </tbody>
  </table></div></div>`;
}

// ── REPORTS HUB (card grid — scales as we add more reports) ───────────────────
function loadReportsHub() {
  var el = document.getElementById('main-content'); if (!el) return;
  var reports = [
    ['CBN Report (PSSP Returns)', 'Monthly CBN PSSP_RETURNS by channel. Excel download.', 'cbn_report', '🏛'],
    ['VAT Report', 'Monthly VAT — output − input per product. Excel download.', 'vat_report', '⊟'],
    ['Revenue Report', 'Fees, rail costs, net pool and margins.', 'revenue', '₦'],
    ['Payout Report', 'Payout volumes, fees and VAT.', 'payout_report', '⇄'],
    ['Rail Settlement', 'Settlement by rail and product.', 'rail_settlement', '⊞'],
  ];
  var cards = reports.map(function (r) {
    return '<div class="card" style="cursor:pointer" onclick="navigate(\'' + r[2] + '\')" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.10)\'" onmouseout="this.style.boxShadow=\'\'">' +
      '<div style="font-size:26px;margin-bottom:8px">' + r[3] + '</div>' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:4px">' + r[0] + '</div>' +
      '<div style="font-size:12px;color:var(--gray-500)">' + r[1] + '</div>' +
      '<div style="margin-top:12px"><span class="btn btn-outline btn-sm">Open →</span></div></div>';
  }).join('');
  el.innerHTML =
    '<div class="page-header"><div class="page-title">Reports</div>' +
    '<div class="page-desc">All Paylode reports. More will be added here over time.</div></div>' +
    '<div class="grid-3">' + cards + '</div>';
}

// ── CBN REPORT (monthly PSSP_RETURNS; Excel in the exact CBN layout) ──────────
async function loadCbnReport() {
  var el = document.getElementById('main-content'); if (!el) return;
  var month = window._cbnMonth || _lastMonthStr(); window._cbnMonth = month;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/reports/cbn?month=' + month);
    var d = (res && res.data) || { channels: [] };
    window._cbnData = d;
    var rows = (d.channels || []).map(function (c) {
      return '<tr><td class="mono">' + c.code + '</td><td>' + c.channel + '</td>' +
        '<td>' + (c.volume || 0).toLocaleString() + '</td>' +
        '<td class="mono">₦' + (c.value || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }) + '</td>' +
        '<td style="font-size:12px">' + c.period + '</td></tr>';
    }).join('');
    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">CBN Report — PSSP Returns</div>' +
        '<div class="page-desc">' + (d.institution || '') + ' · ' + (d.frequency || 'Monthly') + ' · ' + (d.currency || 'NGN') + '. All transactions are WEB.</div></div>' +
        '<div class="flex" style="gap:6px"><a href="#" onclick="navigate(\'reports_hub\');return false" class="btn btn-outline btn-sm">← Reports</a>' +
          '<input type="month" id="cbn-month" value="' + month + '" class="form-input" style="width:auto" onchange="window._cbnMonth=this.value;loadCbnReport()">' +
          '<button class="btn btn-lime btn-sm" onclick="downloadCbnExcel()">&#8681; Download Excel</button>' +
          '<button class="btn btn-outline btn-sm" onclick="emailCbnExcel()">&#9993; Email to me</button></div></div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Channel Code</th><th>Channel</th><th>Volume</th><th>Value</th><th>Period</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr style="font-weight:700"><td colspan="2">TOTAL</td><td>' + (d.total_volume || 0).toLocaleString() + '</td>' +
        '<td class="mono">₦' + (d.total_value || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }) + '</td><td></td></tr></tfoot>' +
      '</table></div></div>';
  } catch (e) { el.innerHTML = errorBox('Failed to load CBN report: ' + e.message); }
}
function _buildCbnWb() {
  var d = window._cbnData; var month = window._cbnMonth;
  if (!d || typeof XLSX === 'undefined') return null;
  var aoa = [
    [],
    ['Frequency', 'Monthly', d.frequency_date],
    ['Participants'],
    [],
    ['', '', '', 'CUR', 'NGN'],
    ['PSSP Institution Name:', d.institution],
    ['PSSP_Code', 'Channel Code', 'Channel', 'Volume1', 'Value1', 'Period'],
  ];
  (d.channels || []).forEach(function (c) { aoa.push(['', c.code, c.channel, c.volume, c.value, c.period]); });
  aoa.push(['', '', '', '', d.total_value]);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'PSSP_RETURNS');
  return { wb: wb, filename: 'CBN Reporting PSSP-' + month + '.xlsx' };
}
function downloadCbnExcel() { var b = _buildCbnWb(); if (!b) { alert('No data, or Excel still loading.'); return; } XLSX.writeFile(b.wb, b.filename); }
async function emailCbnExcel() { var b = _buildCbnWb(); if (!b) { alert('No data, or Excel still loading.'); return; } await _emailXlsx(b.wb, b.filename); }

// ── VAT REPORT (monthly, per product; Excel download for tax authorities) ─────
function _lastMonthStr() {
  var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function _currentMonthStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
async function loadVatReport() {
  var el = document.getElementById('main-content'); if (!el) return;
  var month = window._vatMonth || _currentMonthStr();
  window._vatMonth = month;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/reports/vat?month=' + month);
    var d = (res && res.data) || { products: [], totals: {} };
    window._vatData = d;
    var t = d.totals || {};
    var rows = (d.products || []).length ? d.products.map(function (p) {
      return '<tr><td style="font-weight:500">' + p.product + '</td>' +
        '<td>' + p.txn_count + '</td>' +
        '<td class="mono">' + fmtNaira((p.volume_naira||0)*100) + '</td>' +
        '<td class="mono">' + fmtNaira((p.fee_incl_vat_naira||0)*100) + '</td>' +
        '<td class="mono">' + fmtNaira((p.output_vat_naira||0)*100) + '</td>' +
        '<td class="mono">' + fmtNaira((p.input_vat_naira||0)*100) + '</td>' +
        '<td class="mono" style="font-weight:600">' + fmtNaira((p.net_vat_naira||0)*100) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray-400)">No VAT recorded for this month</td></tr>';
    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">VAT Reports</div>' +
        '<div class="page-desc">Monthly VAT for the tax authority. Net payable = output VAT (on Paylode fees) − input VAT (charged by rails).</div></div>' +
        '<div class="flex" style="gap:6px">' +
          '<input type="month" id="vat-month" value="' + month + '" class="form-input" style="width:auto" onchange="window._vatMonth=this.value;loadVatReport()">' +
          '<button class="btn btn-lime btn-sm" onclick="downloadVatExcel()">&#8681; Download Excel</button>' +
          '<button class="btn btn-outline btn-sm" onclick="emailVatExcel()">&#9993; Email to me</button>' +
        '</div></div>' +
      '<div class="stats-grid" style="margin-bottom:16px">' +
        '<div class="stat-card"><div class="stat-label">Output VAT</div><div class="stat-value">' + fmtNaira((t.output_vat_naira||0)*100) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Input VAT (rails)</div><div class="stat-value">' + fmtNaira((t.input_vat_naira||0)*100) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Net VAT Payable</div><div class="stat-value" style="color:var(--green)">' + fmtNaira((t.net_vat_naira||0)*100) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">' + (t.txn_count||0) + '</div></div>' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Product</th><th>Txns</th><th>Volume</th><th>Fee (incl VAT)</th><th>Output VAT</th><th>Input VAT</th><th>Net VAT</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div></div>' +
      '<div class="info-box" style="margin-top:12px;font-size:12px">' + (d.note || '') + '</div>';
  } catch (e) { el.innerHTML = errorBox('Failed to load VAT report: ' + e.message); }
}
function _buildVatWb() {
  var d = window._vatData; var month = window._vatMonth;
  if (!d || typeof XLSX === 'undefined') return null;
  var t = d.totals || {};
  var summary = [
    ['Paylode Services Limited — VAT Report'],
    ['Month', month], ['VAT rate', d.vat_rate || '7.5%'], ['Generated', new Date().toISOString()],
    [],
    ['Total Output VAT (₦)', t.output_vat_naira || 0],
    ['Total Input VAT (₦)', t.input_vat_naira || 0],
    ['Net VAT Payable (₦)', t.net_vat_naira || 0],
    ['Transactions', t.txn_count || 0],
    [], [d.note || ''],
  ];
  var perProduct = [['Product', 'Txns', 'Volume (₦)', 'Fee incl VAT (₦)', 'Output VAT (₦)', 'Input VAT (₦)', 'Net VAT (₦)']];
  (d.products || []).forEach(function (p) {
    perProduct.push([p.product, p.txn_count, p.volume_naira, p.fee_incl_vat_naira, p.output_vat_naira, p.input_vat_naira, p.net_vat_naira]);
  });
  perProduct.push(['TOTAL', t.txn_count || 0, '', '', t.output_vat_naira || 0, t.input_vat_naira || 0, t.net_vat_naira || 0]);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(perProduct), 'Per Product');
  return { wb: wb, filename: 'Paylode VAT Report ' + month + '.xlsx' };
}
function downloadVatExcel() { var b = _buildVatWb(); if (!b) { alert('No data, or Excel still loading.'); return; } XLSX.writeFile(b.wb, b.filename); }
async function emailVatExcel() { var b = _buildVatWb(); if (!b) { alert('No data, or Excel still loading.'); return; } await _emailXlsx(b.wb, b.filename); }

// ── PRODUCT REVENUE REPORT ────────────────────────────────────────────────────
async function loadProductRevenue(period='month') {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const res = await apiFetch(`/reports/product-revenue?period=${period}`);
    const d = res?.data;
    if (!d) { el.innerHTML = errorBox('Failed to load report'); return; }

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Revenue by Product</div><div class="page-desc">${d.period?.label||period} — ${new Date(d.period?.from).toLocaleDateString('en-NG')} to ${new Date(d.period?.to).toLocaleDateString('en-NG')}</div></div>
      <div class="flex" style="gap:6px">
        ${['week','month','quarter'].map(p=>`<button class="btn ${period===p?'btn-primary':'btn-outline'} btn-sm" onclick="loadProductRevenue('${p}')">${p.charAt(0).toUpperCase()+p.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Total Volume</div><div class="stat-value">${fmtNaira((d.totals?.total_volume||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Revenue</div><div class="stat-value">${fmtNaira((d.totals?.total_revenue||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Paylode Margin</div><div class="stat-value">${fmtNaira((d.totals?.paylode_margin||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${fmtNum(d.totals?.txn_count||0)}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Breakdown by Product</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Transactions</th><th>Volume</th><th>Revenue</th><th>Rail Costs</th><th>Paylode Margin</th><th>Margin %</th></tr></thead>
        <tbody>
          ${d.products?.length ? d.products.map(p=>`<tr>
            <td><span class="tag">${p.product}</span></td>
            <td>${fmtNum(p.txn_count)}</td>
            <td>${fmtNaira(p.volume*100)}</td>
            <td>${fmtNaira(p.gross_revenue*100)}</td>
            <td>${fmtNaira(p.rail_costs*100)}</td>
            <td style="font-weight:600">${fmtNaira(p.paylode_margin*100)}</td>
            <td>${p.margin_pct?.toFixed(1)||0}%</td>
          </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--gray-400)">No revenue data for this period</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
  } catch(e){ el.innerHTML = errorBox('Failed: '+e.message); }
}


async function loadAggOnboard() {
  var el   = document.getElementById('main-content');
  var user = getUser();
  var aggId   = encodeURIComponent((user && (user.id || user.merchantId)) || 'staff');
  var formUrl = '/onboarding.html?type=merchant&ref=' + aggId + '&via=staff';

  el.innerHTML =
    '<div class="page-header">' +
      '<button class="btn btn-outline btn-sm" onclick="goBack()" style="font-size:12px;margin-bottom:10px">&#8592; Back</button>' +
      '<div class="page-title">Onboard New Merchant</div>' +
      '<div class="page-desc">Fill the form on behalf of the merchant, or send them a personal sign-up link</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:860px">' +

      '<div class="card" style="border:2px solid #7dc534;cursor:pointer" id="agg-form-card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128221;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Fill Form Now</div>' +
        '<div class="card-sub" style="margin-bottom:20px">Open the full merchant onboarding form and fill it on behalf of the merchant. Ideal for in-person or phone-assisted onboarding.</div>' +
        '<button id="agg-open-btn" class="btn btn-lime" style="width:100%">Open Onboarding Form &rarr;</button>' +
        '<div style="font-size:12px;color:var(--gray-400);margin-top:10px;text-align:center">Merchant form only &middot; agreement &amp; signature included</div>' +
      '</div>' +

      '<div class="card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128231;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Send Email Invite</div>' +
        '<div class="card-sub" style="margin-bottom:16px">Send the merchant a personal sign-up link. They complete the form themselves at their convenience.</div>' +
        '<div id="inv-alert"></div>' +
        '<div class="form-group"><label class="form-label">Merchant Name <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="inv-name" placeholder="e.g. Zenith Supermarket Ltd"></div>' +
        '<div class="form-group"><label class="form-label">Email Address <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="inv-email" type="email" placeholder="merchant@business.com"></div>' +
        '<div class="form-group"><label class="form-label">Phone Number</label>' +
          '<input class="form-input" id="inv-phone" placeholder="+234 800 000 0000"></div>' +
        '<div class="form-group"><label class="form-label">Business Address</label>' +
          '<input class="form-input" id="inv-address" placeholder="Street, City, State"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="sendMerchantInvite()">Send Invite Email</button>' +
      '</div>' +

    '</div>';

  window.sendMerchantInvite = function() {
    var name    = document.getElementById('inv-name').value.trim();
    var email   = document.getElementById('inv-email').value.trim();
    var phone   = document.getElementById('inv-phone').value.trim();
    var address = document.getElementById('inv-address').value.trim();
    var alertEl = document.getElementById('inv-alert');
    if (!name || !email) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Merchant name and email are required.</div>';
      return;
    }
    var sendBtn = document.querySelector('[onclick="sendMerchantInvite()"]');
    sendBtn.textContent = 'Sending...'; sendBtn.disabled = true;
    apiFetch('/onboarding/invite', {
      method: 'POST',
      body: JSON.stringify({ name: name, email: email, phone: phone, address: address }),
    }).then(function(res) {
      if (res && res.status) {
        alertEl.innerHTML = '<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;font-size:13px;color:#15803d;margin-bottom:12px">&#10003; Invite sent to ' + email + '. The merchant will receive a sign-up link valid for 7 days.</div>';
        document.getElementById('inv-name').value    = '';
        document.getElementById('inv-email').value   = '';
        document.getElementById('inv-phone').value   = '';
        document.getElementById('inv-address').value = '';
      } else {
        alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Failed to send invite.') + '</div>';
      }
      sendBtn.textContent = 'Send Invite Email'; sendBtn.disabled = false;
    }).catch(function(e) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Error: ' + e.message + '</div>';
      sendBtn.textContent = 'Send Invite Email'; sendBtn.disabled = false;
    });
  };

  // Wire open button after innerHTML is set — keeps formUrl in JS closure, no HTML-encoding issues
  setTimeout(function() {
    var b = document.getElementById('agg-open-btn'); if (b) b.onclick = function() { location.href = formUrl; };
    var card = document.getElementById('agg-form-card'); if (card) card.onclick = function() { location.href = formUrl; };
  }, 0);
}

async function loadAdminOnboard() {
  var el      = document.getElementById('main-content');
  var formUrl = '/onboarding.html?type=merchant&via=admin';

  el.innerHTML =
    '<div class="page-header">' +
      '<button class="btn btn-outline btn-sm" onclick="goBack()" style="font-size:12px;margin-bottom:10px">&#8592; Back</button>' +
      '<div class="page-title">Onboard New Merchant</div>' +
      '<div class="page-desc">Fill the form on behalf of the merchant, or send them a personal sign-up link</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:860px">' +

      '<div class="card" style="border:2px solid #7dc534;cursor:pointer" id="adm-form-card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128221;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Fill Form Now</div>' +
        '<div class="card-sub" style="margin-bottom:20px">Open the full onboarding form. All form types are available: Merchant, Aggregator, and Due Diligence.</div>' +
        '<button id="adm-open-btn" class="btn btn-lime" style="width:100%">Open Onboarding Form &rarr;</button>' +
        '<div style="font-size:12px;color:var(--gray-400);margin-top:10px;text-align:center">All form types available &middot; agreement &amp; signature included</div>' +
      '</div>' +

      '<div class="card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128231;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Send Email Invite</div>' +
        '<div class="card-sub" style="margin-bottom:16px">Send the merchant a personal sign-up link by email. They complete the form themselves.</div>' +
        '<div id="adm-inv-alert"></div>' +
        '<div class="form-group"><label class="form-label">Merchant Name <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="adm-inv-name" placeholder="e.g. Zenith Supermarket Ltd"></div>' +
        '<div class="form-group"><label class="form-label">Email Address <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="adm-inv-email" type="email" placeholder="merchant@business.com"></div>' +
        '<div class="form-group"><label class="form-label">Phone Number</label>' +
          '<input class="form-input" id="adm-inv-phone" placeholder="+234 800 000 0000"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:4px" onclick="sendAdminInvite()">Send Invite Email</button>' +
      '</div>' +

    '</div>';

  window.sendAdminInvite = function() {
    var name    = document.getElementById('adm-inv-name').value.trim();
    var email   = document.getElementById('adm-inv-email').value.trim();
    var phone   = document.getElementById('adm-inv-phone').value.trim();
    var alertEl = document.getElementById('adm-inv-alert');
    if (!name || !email) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Merchant name and email are required.</div>';
      return;
    }
    var sendBtn = document.querySelector('[onclick="sendAdminInvite()"]');
    sendBtn.textContent = 'Sending...'; sendBtn.disabled = true;
    apiFetch('/onboarding/invite', {
      method: 'POST',
      body: JSON.stringify({ name: name, email: email, phone: phone }),
    }).then(function(res) {
      if (res && res.status) {
        alertEl.innerHTML = '<div style="background:#dcfce7;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;font-size:13px;color:#15803d;margin-bottom:12px">&#10003; Invite sent to ' + email + '. Link valid for 7 days.</div>';
        document.getElementById('adm-inv-name').value  = '';
        document.getElementById('adm-inv-email').value = '';
        document.getElementById('adm-inv-phone').value = '';
      } else {
        alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Failed.') + '</div>';
      }
      sendBtn.textContent = 'Send Invite Email'; sendBtn.disabled = false;
    }).catch(function(e) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Error: ' + e.message + '</div>';
      sendBtn.textContent = 'Send Invite Email'; sendBtn.disabled = false;
    });
  };

  setTimeout(function() {
    var b = document.getElementById('adm-open-btn'); if (b) b.onclick = function() { location.href = formUrl; };
    var card = document.getElementById('adm-form-card'); if (card) card.onclick = function() { location.href = formUrl; };
  }, 0);
}


async function submitAggOnboard() {
  const name    = document.getElementById('ob-biz-name').value.trim();
  const cat     = document.getElementById('ob-category').value;
  const vol     = document.getElementById('ob-volume').value;
  const contact = document.getElementById('ob-contact-name').value.trim();
  const email   = document.getElementById('ob-email').value.trim();
  const phone   = document.getElementById('ob-phone').value.trim();
  const rc      = document.getElementById('ob-rc').value.trim();
  const address = document.getElementById('ob-address').value.trim();
  const alert   = document.getElementById('onboard-alert');

  if (!name || !cat || !vol || !contact || !email) {
    alert.innerHTML = '<div class="warn-box" style="margin-bottom:16px">Please fill in all required fields.</div>';
    return;
  }

  const btn = document.querySelector('[onclick="submitAggOnboard()"]');
  btn.textContent = 'Submitting...'; btn.disabled = true;

  try {
    const res = await apiFetch('/onboarding/submit', {
      method: 'POST',
      body: JSON.stringify({
        form_type: 'merchant',
        data: {
          institution: { business_name: name, category: cat, expected_monthly_vol: vol, rc_number: rc, address },
          contact: { surname: contact, business_email: email, mobile: phone },
        },
        submitted_at: new Date().toISOString(),
      }),
    });
    if (res && res.status) {
      document.getElementById('main-content').innerHTML = `
        <div class="page-header"><div class="page-title">Application Submitted</div></div>
        <div class="card" style="max-width:520px;text-align:center;padding:40px">
          <div style="font-size:40px;margin-bottom:16px">&#10003;</div>
          <div style="font-size:18px;font-weight:600;margin-bottom:8px">Merchant application sent</div>
          <div style="font-size:13px;color:var(--gray-500);margin-bottom:20px">
            Reference: <span class="mono" style="font-weight:600">${res.data?.reference || ''}</span><br>
            Our compliance team will review within 1-3 business days.
          </div>
          <button class="btn btn-outline" onclick="navigate('agg_merchants')">Back to My Merchants</button>
        </div>`;
    } else {
      alert.innerHTML = `<div class="warn-box" style="margin-bottom:16px">${res?.message || 'Submission failed. Please try again.'}</div>`;
      btn.textContent = 'Submit for Approval →'; btn.disabled = false;
    }
  } catch(e) {
    alert.innerHTML = `<div class="warn-box" style="margin-bottom:16px">Error: ${e.message}</div>`;
    btn.textContent = 'Submit for Approval →'; btn.disabled = false;
  }
}

// ── UPDATE loadPageData TO INCLUDE NEW PAGES ─────────────────────────────────
var _origLoadPageData = loadPageData;
loadPageData = function(page) {
  // Section hubs are rendered by renderSectionHub() in renderPage(); no data load.
  if (page && page.indexOf('hub::') === 0) return;
  switch(page) {
    case 'agg_onboard':          loadAggOnboard(); break;
    case 'agg_revenue':          loadAggRevenue(); break;
    case 'admin_onboard':        loadAdminOnboard(); break;
    case 'payouts':              loadPayouts(); break;
    case 'payout_report':        loadPayoutReport(); break;
    case 'payout_logs':          loadPayoutLogs(); break;
    case 'vat_report':           loadVatReport(); break;
    case 'cbn_report':           loadCbnReport(); break;
    case 'reports_hub':          loadReportsHub(); break;
    case 'fee_config':           loadFeeConfig(); break;
    case 'rail_settlement':      loadRailSettlement(); break;
    case 'rails':                loadRails(); break;
    case 'service_providers':    loadServiceProviders(); break;
    case 'wallets':              loadWallets(); break;
    case 'product_revenue':      loadProductRevenue(); break;
    case 'merch_payments':       loadMerchPaymentLinks(); break;
    // Staff Accounts: app.js renderUserManagement() (full permission matrix +
    // per-user Permissions modal) already rendered & scheduled loadUsers(); do
    // not overwrite with the simpler role-only table. (#7)
    case 'users':                break;
    case 'settle_verification':  loadSettlementQueue(); break;
    case 'email_tpl':            loadEmailTemplates(); break;
    case 'onboarding_apps':      loadOnboardingApps(); break;
    case 'invite_tracking':      loadInviteTracking(); break;
    case 'compliance':           loadCompliance(); break;          // KYC Review (domestic Naira)
    case 'compliance_centre':    break;                            // renderCompliance() self-loads its tabs
    case 'compliance_exceptions':
      if ((window.__cmplExcTab || 'exceptions') === 'matrix') loadComplianceMatrix(); else loadComplianceExceptions(); break;
    case 'deferrals':            loadDeferrals(); break;
    case 'activity_log':         loadActivityLog(); break;
    // Static pages — _origRenderPage already rendered them, do not overwrite
    case 'settings':
    case 'sdk_start':
    case 'sdk_payments':
    case 'sdk_va':
    case 'sdk_verify':
    case 'sdk_payouts':
    case 'sdk_webhook':
    case 'sdk_mobile':
    case 'sdk_errors':
    case 'sdk_test':
      break;
    default: _origLoadPageData(page);
  }
};

// ════════════════════════════════════════════════════════════════════════════
//  ONBOARDING APPLICATIONS (compliance review) + DOCUMENT DEFERRALS (superadmin)
// ════════════════════════════════════════════════════════════════════════════

function _escA(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Compliance Exceptions (Mastercard Rules dispositions) ────────────────────
function _sevBadge(sev) {
  var m = { BLOCKING:'badge-red', REVIEW:'badge-amber', MONITOR:'badge-gray' };
  return '<span class="badge ' + (m[sev] || 'badge-gray') + '">' + _escA(sev) + '</span>';
}
function _excStatusBadge(st) {
  var m = { open:'badge-amber', deferred:'badge-blue', cleared:'badge-green', blocked:'badge-red' };
  return '<span class="badge ' + (m[st] || 'badge-gray') + '">' + _escA((st || '').toUpperCase()) + '</span>';
}

async function loadComplianceExceptions() {
  var el = document.getElementById('cmpl-exc');
  if (!el) return;
  var st = (document.getElementById('cmpl-status') || {}).value || '';
  el.innerHTML = '<div class="info-box">&#8987; Loading exceptions…</div>';
  var res = await apiFetch('/compliance/exceptions' + (st ? '?status=' + st : ''));
  if (!res || !res.status) { el.innerHTML = '<div class="warn-box">&#9888; ' + ((res && res.message) || 'Failed to load') + '</div>'; return; }
  var rows = (res.data.exceptions || []);
  if (!rows.length) { el.innerHTML = '<div class="info-box">No compliance exceptions' + (st ? ' with status "' + _escA(st) + '"' : '') + '.</div>'; return; }
  var body = rows.map(function(x) {
    var isMerchant = x.entity_type === 'merchant';
    // Mastercard exception dispositions (defer/clear/block) are SA-only (backend requireSuperAdmin).
    var canAct = (x.status === 'open' || x.status === 'deferred') && currentRole === 'superadmin';
    var actions = canAct ? (
      '<button class="btn btn-outline btn-sm" onclick="deferComplianceException(\'' + x.id + '\',' + (x.deferrable ? 'true' : 'false') + ')">Defer</button> ' +
      '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="clearComplianceException(\'' + x.id + '\')">Clear</button> ' +
      '<button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="blockComplianceException(\'' + x.id + '\')">Block</button>'
    ) : '<span style="color:var(--gray-400);font-size:12px">—</span>';
    var deferInfo = x.deferred_until ? '<div style="font-size:11px;color:var(--gray-400)">until ' + new Date(x.deferred_until).toLocaleDateString() + '</div>' : '';
    return '<tr>' +
      '<td><span class="tag">' + _escA(x.rule_code) + '</span></td>' +
      '<td>' + _sevBadge(x.severity) + (x.deferrable ? '' : ' <span class="badge badge-red" title="absolute prohibition">HARD</span>') + '</td>' +
      '<td>' + _excStatusBadge(x.status) + deferInfo + '</td>' +
      '<td style="font-size:12px">' + _escA(x.merchant_name || x.entity_type) + '</td>' +
      '<td style="font-size:12px;max-width:340px">' + _escA(x.description || '') + (x.reason ? '<div style="font-size:11px;color:var(--gray-400)">SA: ' + _escA(x.reason) + '</div>' : '') + '</td>' +
      '<td style="white-space:nowrap">' + actions + '</td>' +
    '</tr>';
  }).join('');
  var sum = res.data.summary || {};
  var chips = Object.keys(sum).map(function(k){ return '<span class="badge badge-gray" style="margin-right:6px">' + _escA(k) + ': ' + sum[k] + '</span>'; }).join('');
  el.innerHTML = '<div style="margin-bottom:10px">' + chips + '</div>' +
    '<div class="card"><div class="table-wrap"><table style="width:100%"><thead><tr>' +
    '<th>Rule</th><th>Severity</th><th>Status</th><th>Entity</th><th>Detail</th><th>Action</th></tr></thead><tbody>' +
    body + '</tbody></table></div></div>';
}

async function deferComplianceException(id, deferrable) {
  var months = prompt('Defer for how many months? (1, 2, 3 or 6)', '3');
  if (months === null) return;
  if (['1','2','3','6'].indexOf(String(months).trim()) === -1) { alert('Enter 1, 2, 3 or 6.'); return; }
  var reason = prompt('Reason / disposition note' + (deferrable ? ' (optional)' : ' (REQUIRED — overriding an absolute prohibition):'), '');
  if (reason === null) return;
  var force = !deferrable;
  if (force && !String(reason).trim()) { alert('A reason is required to override an absolute prohibition.'); return; }
  if (force && !confirm('This is a HARD prohibition. Overriding it is logged against your account. Proceed?')) return;
  var res = await apiFetch('/compliance/exceptions/' + id + '/defer', {
    method: 'POST', body: JSON.stringify({ duration_months: Number(months), reason: reason || undefined, force: force }),
  });
  if (res && res.status) loadComplianceExceptions();
  else alert('Error: ' + ((res && res.message) || 'Defer failed'));
}

async function clearComplianceException(id) {
  var reason = prompt('Clear this exception (false positive / resolved). Reason:', '');
  if (reason === null) return;
  var res = await apiFetch('/compliance/exceptions/' + id + '/clear', { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
  if (res && res.status) loadComplianceExceptions();
  else alert('Error: ' + ((res && res.message) || 'Clear failed'));
}

async function blockComplianceException(id) {
  if (!confirm('Confirm the block? The merchant will be suspended.')) return;
  var reason = prompt('Reason for the block:', '');
  if (reason === null) return;
  var res = await apiFetch('/compliance/exceptions/' + id + '/block', { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) });
  if (res && res.status) loadComplianceExceptions();
  else alert('Error: ' + ((res && res.message) || 'Block failed'));
}

async function loadComplianceMatrix() {
  var el = document.getElementById('cmpl-matrix');
  if (!el) return;
  var res = await apiFetch('/compliance/matrix');
  if (!res || !res.status) { el.innerHTML = '<div class="warn-box">&#9888; ' + ((res && res.message) || 'Failed to load') + '</div>'; return; }
  var cls = function(v) { var m = { prohibited:'badge-red', restricted:'badge-amber', allowed:'badge-green' }; return '<span class="badge ' + (m[v] || 'badge-gray') + '">' + _escA(v) + '</span>'; };
  var mccRows = (res.data.mccs || []).map(function(r) {
    return '<tr><td class="mono">' + _escA(r.mcc) + '</td><td style="font-size:12px">' + _escA(r.label) + '</td><td>' + cls(r.local) + '</td><td>' + cls(r.international) + '</td></tr>';
  }).join('');
  var bramRows = (res.data.bram || []).map(function(b) {
    return '<tr><td style="font-size:12px">' + _escA(b.category) + '</td><td style="font-size:11px;color:var(--gray-400)">' + _escA((b.keywords || []).join(', ')) + '</td></tr>';
  }).join('');
  el.innerHTML =
    '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Merchant Category Codes (MCC)</div>' +
    '<div class="card-subtitle">Classification differs by card-acceptance scope. Prohibited = hard block; Restricted = enhanced due diligence.</div></div>' +
    '<div class="table-wrap"><table style="width:100%"><thead><tr><th>MCC</th><th>Category</th><th>Local</th><th>International</th></tr></thead><tbody>' + mccRows + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">BRAM — Prohibited Activities</div>' +
    '<div class="card-subtitle">Screened from the business description; any match is an absolute block.</div></div>' +
    '<div class="table-wrap"><table style="width:100%"><thead><tr><th>Category</th><th>Trigger keywords</th></tr></thead><tbody>' + bramRows + '</tbody></table></div></div>';
}

function riskBadge(level) {
  var map = { high:'badge-red', medium:'badge-amber', low:'badge-green' };
  return '<span class="badge ' + (map[(level||'').toLowerCase()] || 'badge-gray') + '">' + (level || '—').toUpperCase() + '</span>';
}
function yesNoBadge(v) { return v ? '<span class="badge badge-red">YES</span>' : '<span class="badge badge-gray">No</span>'; }

// Expanded KYC/KYB document requirements (mirrors the onboarding form, 2026-06-13)
var KYB_REQUIRED_DOCS = {
  natural: [
    'Government-issued ID (passport / driver’s licence / voter’s card)',
    'Proof of address (≤3 months)',
    'BVN', 'NIN',
  ],
  entity_common: [
    'TIN certificate', 'Proof of business address (≤3 months)',
    'Per-director / shareholder / trustee: ID + BVN (NIN where available)',
  ],
  entity_by_type: {
    'Limited Liability Company': ['Certificate of Incorporation', 'MEMART', 'CAC Status Report (or Form CO2 + CO7)', 'Board Resolution'],
    'Unlimited Liability Company': ['Certificate of Incorporation', 'MEMART', 'CAC Status Report (or Form CO2 + CO7)', 'Board Resolution'],
    'Sole Proprietorship / Business Name': ['Certificate of Registration of Business Name', 'CAC Application / Status Report'],
    'Partnership': ['Certificate of Registration', 'Partnership Deed / Agreement'],
    'Registered Trust': ['Certificate of Registration (Incorporated Trustees)', 'Constitution / Trust Deed', 'List of Trustees'],
    'Registered Charity': ['Certificate of Registration (Incorporated Trustees)', 'Constitution / Governing Instrument', 'List of Trustees'],
    'Professional Body (established by Act)': ['Copy of enabling Act / extract', 'List of Governing Council members'],
  },
};

function allDocChecklist() {
  var items = [];
  KYB_REQUIRED_DOCS.natural.forEach(function(d){ items.push(d); });
  KYB_REQUIRED_DOCS.entity_common.forEach(function(d){ items.push(d); });
  Object.keys(KYB_REQUIRED_DOCS.entity_by_type).forEach(function(t){
    KYB_REQUIRED_DOCS.entity_by_type[t].forEach(function(d){ if (items.indexOf(d) === -1) items.push(d); });
  });
  return items;
}

// ── Compliance: Applications list ─────────────────────────────────────────────
// SA/compliance: invite funnel — who was invited, how far they got, who's pending.
async function loadInviteTracking() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const res = await apiFetch('/onboarding/invites');
    const rows = res?.data || [];
    const badge = { submitted:'badge-green', started:'badge-blue', opened:'badge-amber', sent:'badge-gray' };
    const label = { submitted:'Submitted', started:'Started form', opened:'Opened link', sent:'Not opened' };
    const counts = { sent:0, opened:0, started:0, submitted:0 };
    rows.forEach(r => { counts[r.status] = (counts[r.status]||0)+1; });
    const pending = rows.filter(r => r.status !== 'submitted');
    const fmtD = d => d ? new Date(d).toLocaleString() : '—';
    const body = rows.length ? rows.map(r => `<tr style="border-bottom:1px solid var(--gray-100)${r.status!=='submitted'&&r.days_pending>=2?';background:#fffbeb':''}">
      <td style="padding:8px"><div style="font-weight:500">${r.name||'—'}</div><div class="mono" style="font-size:11px;color:var(--gray-400)">${r.email}</div></td>
      <td style="padding:8px;font-size:12px">${(r.type||'—')}</td>
      <td style="padding:8px"><span class="badge ${badge[r.status]||'badge-gray'}">${label[r.status]||r.status}</span></td>
      <td style="padding:8px;font-size:11px">opened: ${fmtD(r.opened_at)}<br>started: ${fmtD(r.started_at)}<br>submitted: ${fmtD(r.submitted_at)}</td>
      <td style="padding:8px;font-size:12px">${fmtD(r.invited_at)}${r.status!=='submitted'?`<div style="color:${r.days_pending>=2?'var(--red)':'var(--gray-400)'};font-size:11px">${r.days_pending} day(s) pending</div>`:''}</td>
      <td style="padding:8px;font-size:11px;color:var(--gray-500)">${r.invited_by||'—'}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--gray-400)">No invites sent yet</td></tr>';
    el.innerHTML = `
      <div class="page-header"><div class="page-title">Invite Tracking</div>
        <div class="page-desc">Invitees who got a self-onboard link — how far they got, and who hasn't submitted (highlighted) so you can follow up on the delay.</div></div>
      <div class="stats-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
        <div class="stat-card"><div class="stat-label">Not opened</div><div class="stat-value">${counts.sent||0}</div></div>
        <div class="stat-card"><div class="stat-label">Opened, not started</div><div class="stat-value text-amber">${counts.opened||0}</div></div>
        <div class="stat-card"><div class="stat-label">Started, not submitted</div><div class="stat-value" style="color:#1e40af">${counts.started||0}</div></div>
        <div class="stat-card"><div class="stat-label">Submitted</div><div class="stat-value text-lime">${counts.submitted||0}</div></div>
      </div>
      ${pending.length?`<div class="info-box" style="margin-bottom:12px;font-size:12px">${pending.length} invitee(s) haven't submitted yet — rows pending 2+ days are highlighted.</div>`:''}
      <div class="card"><div class="table-wrap"><table style="width:100%">
        <thead><tr><th>Invitee</th><th>Type</th><th>Status</th><th>Funnel</th><th>Invited</th><th>By</th></tr></thead>
        <tbody>${body}</tbody></table></div></div>`;
  } catch (e) { el.innerHTML = errorBox('Failed to load invite tracking: ' + e.message); }
}

// ── Onboarding lifecycle (cycle) helpers ──────────────────────────────────────
function _fmtDur(ms) {
  if (ms == null || ms < 0) return '—';
  var m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return d + 'd ' + (h % 24) + 'h';
  if (h >= 1) return h + 'h ' + (m % 60) + 'm';
  return Math.max(m, 1) + 'm';
}
function _onbHist(a) {
  var h = a && a.statusHistory;
  if (typeof h === 'string') { try { h = JSON.parse(h); } catch (e) { h = null; } }
  return Array.isArray(h) ? h : [];
}
// Short one-liner for the list: how far the application is + how long it took.
function _onbCycleSummary(a) {
  var hist = _onbHist(a);
  var startAt = (hist.find && (hist.find(function (e) { return e.status === 'submitted'; }) || {}).at) || a.submittedAt;
  if (!startAt) return '—';
  var start = new Date(startAt).getTime();
  var find = function (s) { var e = hist.filter(function (x) { return x.status === s; }).pop(); return e ? new Date(e.at).getTime() : null; };
  var activated = find('activated'), approved = find('approved');
  var resubs = hist.filter(function (x) { return x.status === 'resubmitted'; }).length;
  var rj = resubs ? ' · ' + resubs + '× resubmit' : '';
  if (activated) return '<span class="badge badge-green">Live</span> in ' + _fmtDur(activated - start) + rj;
  if (approved)  return '<span class="badge badge-blue">Approved</span> in ' + _fmtDur(approved - start) + rj;
  return _fmtDur(Date.now() - start) + ' in pipeline' + rj;
}
// Full vertical timeline for the detail modal.
function _onbTimelineHtml(a) {
  var hist = _onbHist(a);
  if (!hist.length) return '';
  var labels = { submitted:'Submitted', under_review:'Under review', rejected:'Rejected', resubmitted:'Resubmitted', approved:'Approved', activated:'Activated (live)' };
  var colors = { submitted:'#64748b', under_review:'#1e40af', rejected:'#b91c1c', resubmitted:'#9a6700', approved:'#166534', activated:'#0f7b3f' };
  var start = new Date(hist[0].at).getTime();
  var rows = hist.map(function (e) {
    var t = new Date(e.at);
    var delta = (e.at && hist[0].at && t.getTime() !== start) ? ' <span style="color:var(--gray-400)">(+' + _fmtDur(t.getTime() - start) + ')</span>' : '';
    return '<div style="display:flex;gap:10px;align-items:flex-start;padding:5px 0">' +
      '<span style="flex:0 0 9px;height:9px;border-radius:50%;margin-top:5px;background:' + (colors[e.status] || '#64748b') + '"></span>' +
      '<div style="font-size:12px"><strong>' + (labels[e.status] || e.status) + '</strong>' + delta +
      '<div style="color:var(--gray-500)">' + t.toLocaleString('en-NG') + (e.note ? ' · ' + _escA(e.note) : '') + '</div></div></div>';
  }).join('');
  var last = new Date(hist[hist.length - 1].at).getTime();
  return '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Onboarding cycle ' +
    '<span style="font-weight:400;color:var(--gray-500)">· total ' + _fmtDur(last - start) + '</span></div>' +
    '<div style="border-left:2px solid var(--gray-200);margin-left:4px;padding-left:10px">' + rows + '</div>';
}

async function loadOnboardingApps() {
  var el = document.getElementById('main-content');
  el.innerHTML = loading();
  var res = await apiFetch('/onboarding/submissions');
  var rows = (res && res.data) ? res.data : [];
  window._onbApps = rows;

  var body = rows.length ? rows.map(function(a) {
    var typ = (a.formType || '') + (a.applicantType ? ' / ' + a.applicantType : '');
    return '<tr>' +
      '<td class="mono" style="font-size:12px">' + _escA(a.reference) + '</td>' +
      '<td>' + _escA(typ) + '</td>' +
      '<td style="font-weight:500">' + _escA(a.businessName || '—') + '</td>' +
      '<td>' + riskBadge(a.riskLevel) + '</td>' +
      '<td>' + yesNoBadge(a.pepFlag) + '</td>' +
      '<td>' + (a.sanctionsHit ? '<span class="badge badge-red">REVIEW</span>' : '<span class="badge badge-green">Clear</span>') + '</td>' +
      '<td style="font-size:12px">' + (a.submittedAt ? new Date(a.submittedAt).toLocaleDateString('en-NG') : '—') + '</td>' +
      '<td>' + statusBadge(a.status) + '</td>' +
      '<td style="font-size:12px">' + _onbCycleSummary(a) + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="viewOnboardingApp(\'' + _escA(a.reference) + '\')">Review</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:20px">No applications yet</td></tr>';

  el.innerHTML =
    '<div class="page-header flex-between"><div>' +
      '<div class="page-title">Onboarding Applications</div>' +
      '<div class="page-desc">' + rows.length + ' application' + (rows.length !== 1 ? 's' : '') + ' · KYC/KYB review</div>' +
    '</div></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
      '<thead><tr><th>Reference</th><th>Type</th><th>Business</th><th>Risk</th><th>PEP</th><th>Sanctions</th><th>Submitted</th><th>Status</th><th>Cycle</th><th></th></tr></thead>' +
      '<tbody>' + body + '</tbody>' +
    '</table></div></div>';
}

// ── Compliance: Application detail ────────────────────────────────────────────
async function viewOnboardingApp(ref) {
  var res = await apiFetch('/onboarding/submissions/' + encodeURIComponent(ref));
  if (!res || !res.data) { alert('Could not load application'); return; }
  var a = res.data;
  var data = a.data || {};

  function section(title, obj) {
    if (!obj || !Object.keys(obj).length) return '';
    var rows = Object.keys(obj).map(function(k) {
      var v = obj[k];
      if (v == null || v === '' || typeof v === 'object') return '';
      return '<div class="rev-row"><span class="rev-label">' + _escA(k.replace(/_/g,' ')) + '</span><span class="rev-value" style="font-size:12px">' + _escA(v) + '</span></div>';
    }).join('');
    return rows ? '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">' + title + '</div>' + rows : '';
  }

  var principals = (a.principals || []).map(function(p) {
    return '<tr>' +
      '<td>' + _escA(p.role || '') + '</td>' +
      '<td>' + _escA([p.first_name, p.other_names, p.surname].filter(Boolean).join(' ')) + '</td>' +
      '<td class="mono" style="font-size:12px">' + _escA(p.bvn || '') + '</td>' +
      '<td>' + (p.is_ubo ? 'UBO ' : '') + (p.pct_shareholding ? _escA(p.pct_shareholding) + '%' : '') + '</td>' +
      '<td>' + (p.is_pep ? '<span class="badge badge-red">PEP</span>' : '') + '</td>' +
      '<td>' + _escA(p.id_type || '') + '</td>' +
    '</tr>';
  }).join('');
  var principalsHtml = (a.principals && a.principals.length)
    ? '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Directors / Owners / Trustees</div>' +
      '<div class="table-wrap"><table style="width:100%"><thead><tr><th>Role</th><th>Name</th><th>BVN</th><th>Holding</th><th>PEP</th><th>ID</th></tr></thead><tbody>' + principals + '</tbody></table></div>'
    : '';

  var docs = (a.documents || []).filter(function(d){ return d.path; }).map(function(d) {
    return '<button class="btn btn-outline btn-sm" style="margin:0 6px 6px 0" onclick="downloadAppDoc(\'' + _escA(a.reference) + '\',\'' + _escA(d.key) + '\')">↓ ' + _escA(d.name || d.key) + '</button>';
  }).join('');
  var docsHtml = docs ? '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Documents</div><div>' + docs + '</div>' : '<div class="info-box" style="margin-top:12px;font-size:12px">No document files stored on server.</div>';

  var notes = (a.screeningNotes || []);

  // Mastercard Rules compliance exceptions for the provisioned merchant (if any).
  var excHtml = '';
  if (a.merchantId) {
    var excRes = await apiFetch('/compliance/exceptions?entity_type=merchant&entity_id=' + encodeURIComponent(a.merchantId));
    var exc = (excRes && excRes.data && excRes.data.exceptions) || [];
    if (exc.length) {
      var excRows = exc.map(function(x) {
        return '<div class="rev-row"><span class="rev-label">' + _sevBadge(x.severity) + ' ' + _escA(x.rule_code) + '</span>' +
          '<span class="rev-value" style="font-size:12px;text-align:right">' + _excStatusBadge(x.status) + '<br><span style="color:var(--gray-400)">' + _escA(x.description || '') + '</span></span></div>';
      }).join('');
      var hasBlock = exc.some(function(x){ return x.severity === 'BLOCKING' && (x.status === 'open' || x.status === 'blocked'); });
      excHtml = '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Compliance Exceptions ' +
        (hasBlock ? '<span class="badge badge-red">BLOCKED — cannot approve</span>' : '') + '</div>' + excRows +
        '<div class="info-box" style="font-size:11px;margin-top:6px">Manage these in <strong>Compliance Exceptions</strong> (defer / clear / block).</div>';
    }
  }

  var screeningHtml =
    '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Screening</div>' +
    '<div class="rev-row"><span class="rev-label">Risk level</span><span class="rev-value">' + riskBadge(a.riskLevel) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">PEP</span><span class="rev-value">' + yesNoBadge(a.pepFlag) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Sanctions match</span><span class="rev-value">' + (a.sanctionsHit ? '<span class="badge badge-red">REVIEW</span>' : '<span class="badge badge-green">Clear</span>') + '</span></div>' +
    (notes.length ? '<ul style="font-size:12px;color:var(--gray-500);margin:8px 0 0 18px">' + notes.map(function(n){return '<li>' + _escA(n) + '</li>';}).join('') + '</ul>' : '') +
    excHtml;

  var sig = a.signature ? '<div style="font-weight:600;margin:14px 0 6px;font-size:13px">Signature</div><img src="' + a.signature + '" style="max-width:260px;border:1px solid var(--gray-200);border-radius:6px">' : '';

  var refJs = _escA(a.reference);
  var actions =
    '<div class="divider"></div>' +
    '<label class="form-label">Review note / reviewer comments</label>' +
    '<textarea class="form-input" id="onb-note" style="min-height:60px;margin-bottom:10px" placeholder="Comments shown to the merchant with the decision (e.g. what to correct)">' + _escA(a.reviewNotes || '') + '</textarea>' +
    rejectChecklistHtml(a) +
    '<div class="flex" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-outline" onclick="reviewOnboardingApp(\'' + refJs + '\',\'under_review\')">Mark Under Review</button>' +
      '<button class="btn btn-outline" style="color:var(--green);border-color:var(--green)" onclick="reviewOnboardingApp(\'' + refJs + '\',\'approved\')">Approve</button>' +
      '<button class="btn btn-outline" style="color:var(--red);border-color:var(--red)" onclick="showRejectChecklist()">Reject…</button>' +
    '</div>' +
    '<div id="reject-confirm" style="display:none;margin-top:10px">' +
      '<button class="btn btn-primary" style="background:var(--red);border-color:var(--red)" onclick="reviewOnboardingApp(\'' + refJs + '\',\'rejected\')">Confirm Rejection &amp; Notify Merchant</button>' +
    '</div>';

  showModal(
    '<div class="modal-header"><div class="modal-title">' + _escA(a.businessName || a.reference) + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="rev-row"><span class="rev-label">Reference</span><span class="rev-value mono" style="font-size:12px">' + _escA(a.reference) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Type</span><span class="rev-value">' + _escA((a.formType||'') + (a.applicantType ? ' / ' + a.applicantType : '')) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Status</span><span class="rev-value">' + statusBadge(a.status) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Reg. No / TIN</span><span class="rev-value mono" style="font-size:12px">' + _escA(a.regNumber||'—') + ' / ' + _escA(a.tin||'—') + '</span></div>' +
    section('Individual', data.np_identity) +
    section('Business', data.np_business) +
    section('Entity', data.entity_details) +
    _onbTimelineHtml(a) +
    principalsHtml +
    docsHtml +
    screeningHtml +
    sig +
    actions
  );
}

// Rejection checklist — candidate missing items the reviewer ticks. Doc keys match
// the kyc_documents doc_keys so the backend can flag them for re-upload.
function rejectChecklistHtml(a) {
  var docItems = (a.applicantType === 'natural')
    ? [['id_document','Government-issued ID'],['proof_address','Proof of address'],['bvn','BVN'],['nin','NIN']]
    : [['cert_incorp','Certificate of Incorporation / Registration'],['memart','MEMART'],['status_report','CAC Status Report (or CO2 + CO7)'],['board_resolution','Board Resolution'],['tin_cert','TIN certificate'],['proof_address','Proof of business address'],['id_document','Government-issued ID (director / owner)']];
  var infoItems = [['settlement_account','Settlement bank account'],['business_info','Business details / description'],['contact_info','Valid contact email / phone'],['principal_info','Director / owner details']];
  function ck(d, type) {
    return '<label style="display:flex;gap:7px;align-items:center;font-size:13px;padding:3px 0;cursor:pointer">' +
      '<input type="checkbox" class="rej-item" data-key="' + d[0] + '" data-label="' + _escA(d[1]) + '" data-type="' + type + '"> ' +
      _escA(d[1]) + (type === 'doc' ? ' <span style="color:var(--gray-400);font-size:11px">(doc)</span>' : '') + '</label>';
  }
  return '<div id="reject-checklist" style="display:none;border:1px solid #f3c2c2;background:#fff8f8;border-radius:8px;padding:10px 12px;margin-bottom:10px">' +
    '<div style="font-weight:600;font-size:13px;color:#7a2222;margin-bottom:6px">Tick what is missing or unacceptable</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      docItems.map(function(d){return ck(d,'doc');}).join('') + infoItems.map(function(d){return ck(d,'info');}).join('') +
    '</div>' +
    '<div style="font-size:11px;color:var(--gray-500);margin-top:6px">Sent to the merchant as their correction checklist; ticked documents are flagged for re-upload.</div>' +
  '</div>';
}

function showRejectChecklist() {
  var c = document.getElementById('reject-checklist'); if (c) c.style.display = 'block';
  var b = document.getElementById('reject-confirm'); if (b) b.style.display = 'block';
}

async function reviewOnboardingApp(ref, status) {
  var note = (document.getElementById('onb-note') || {}).value || '';
  var missing = [];
  if (status === 'rejected') {
    document.querySelectorAll('.rej-item:checked').forEach(function (cb) {
      missing.push({ key: cb.getAttribute('data-key'), label: cb.getAttribute('data-label'), type: cb.getAttribute('data-type') });
    });
    if (!missing.length && !note.trim()) { alert('Add a reviewer note or tick at least one missing item so the merchant knows what to fix.'); return; }
  }
  var verb = status === 'approved' ? 'approve' : status === 'rejected' ? 'reject' : 'mark under review';
  if (!confirm('Are you sure you want to ' + verb + ' this application?')) return;
  var body = { status: status, review_notes: note };
  if (status === 'rejected') body.missing_items = missing;
  var res = await apiFetch('/onboarding/submissions/' + encodeURIComponent(ref), {
    method: 'PATCH', body: JSON.stringify(body),
  });
  if (res && res.status) { document.getElementById('modal').style.display = 'none'; loadOnboardingApps(); }
  else alert('Error: ' + ((res && res.message) || 'Update failed'));
}

async function downloadAppDoc(ref, key) {
  var token = sessionStorage.getItem('paylode_token');
  try {
    var r = await fetch(API_BASE + '/onboarding/submissions/' + encodeURIComponent(ref) + '/document/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { alert('Could not load document'); return; }
    var b = await r.blob();
    window.open(URL.createObjectURL(b), '_blank');
  } catch (e) { alert('Error opening document'); }
}

// ── Superadmin: Document Deferrals ────────────────────────────────────────────
async function loadDeferrals() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
  var res = await apiFetch('/merchants');
  var ms = (res && res.data) ? res.data : [];

  var reqHtml = '<div class="card" style="margin-bottom:16px">' +
    '<div style="font-weight:600;margin-bottom:6px">Required KYC / KYB Documents</div>' +
    '<div class="page-desc" style="margin-bottom:10px">Documents collected at onboarding. Open a merchant to track each document individually and defer specific outstanding items (1–6 months); overdue deferrals auto-suspend the account.</div>' +
    '<div style="font-weight:600;font-size:12px;margin:8px 0 4px">Individual</div><ul style="font-size:12px;color:var(--gray-600);margin-left:18px">' + KYB_REQUIRED_DOCS.natural.map(function(d){return '<li>' + _escA(d) + '</li>';}).join('') + '</ul>' +
    '<div style="font-weight:600;font-size:12px;margin:10px 0 4px">Registered business (all)</div><ul style="font-size:12px;color:var(--gray-600);margin-left:18px">' + KYB_REQUIRED_DOCS.entity_common.map(function(d){return '<li>' + _escA(d) + '</li>';}).join('') + '</ul>' +
    '<div style="font-weight:600;font-size:12px;margin:10px 0 4px">By entity type</div>' +
    Object.keys(KYB_REQUIRED_DOCS.entity_by_type).map(function(t){
      return '<div style="font-size:12px;color:var(--gray-600);margin-left:8px"><strong>' + _escA(t) + ':</strong> ' + KYB_REQUIRED_DOCS.entity_by_type[t].map(_escA).join(', ') + '</div>';
    }).join('') +
    '</div>';

  var body = ms.length ? ms.map(function(m) {
    return '<tr>' +
      '<td style="font-weight:500">' + _escA(m.businessName || '—') + '</td>' +
      '<td>' + statusBadge(m.kycStatus) + '</td>' +
      '<td>' + (m.isActive ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>') + '</td>' +
      '<td><button class="btn btn-outline btn-sm" onclick="openDocsModal(\'merchant\',\'' + m.id + '\',\'' + _escA((m.businessName||'').replace(/'/g,'')) + '\')">Manage Documents</button></td>' +
    '</tr>';
  }).join('') : '<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:20px">No merchants</td></tr>';

  el.innerHTML =
    '<div class="page-header"><div class="page-title">KYC Documents &amp; Deferrals</div>' +
      '<div class="page-desc">Per-document tracking — mark submitted/verified/waived, or defer specific documents (superadmin)</div></div>' +
    reqHtml +
    '<div class="card"><div class="table-wrap"><table>' +
      '<thead><tr><th>Merchant</th><th>KYC Status</th><th>Account</th><th></th></tr></thead>' +
      '<tbody>' + body + '</tbody>' +
    '</table></div></div>';
  } catch (e) {
    el.innerHTML = errorBox('Failed to load KYC Documents & Deferrals: ' + (e && e.message ? e.message : e));
  }
}

async function openDocsModal(entityType, id, name) {
  var res = await apiFetch('/documents/' + entityType + '/' + id);
  var data = (res && res.data) ? res.data : { docs: [], summary: {} };
  window._docCtx = { entityType: entityType, id: id, name: name };

  // Actual files the applicant uploaded at onboarding — reviewers VIEW these before acting.
  var upRes = await apiFetch('/documents/uploaded/' + entityType + '/' + id);
  var uploaded = (upRes && upRes.data) ? upRes.data : { reference: null, files: [] };
  var uploadedHtml = (uploaded.files && uploaded.files.length)
    ? '<div style="font-weight:600;margin:2px 0 6px">Uploaded documents (' + uploaded.files.length + ')</div>' +
      '<div class="table-wrap" style="margin-bottom:14px"><table style="width:100%"><thead><tr><th>Document</th><th>Type</th><th></th></tr></thead><tbody>' +
      uploaded.files.map(function(f){
        return '<tr><td style="font-weight:500">' + _escA(f.name) + (f.principal ? ' <span class="upload-hint">(' + _escA(f.principal) + ')</span>' : '') + '</td>' +
          '<td style="font-size:12px;color:var(--gray-500)">' + _escA(f.doc_type || f.key || '') + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + (f.has_file
            ? '<button class="btn btn-outline btn-sm" onclick="viewUploadedFile(\'' + uploaded.reference + '\',' + f.i + ')">View</button> ' +
              '<button class="btn btn-outline btn-sm" onclick="downloadUploadedFile(\'' + uploaded.reference + '\',' + f.i + ',\'' + _escA((f.name||'document').replace(/\x27/g,'')) + '\')">Download</button>'
            : '<span style="color:var(--gray-400);font-size:12px">no file</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
    : '<div class="page-desc" style="margin-bottom:12px">No uploaded files on record for this account.</div>';

  // Actor matrix: doc review (verify/reject/submitted/waive) = SA + Admin + Compliance;
  // document DEFERRAL (activate despite outstanding) = SA only.
  var canEdit  = (['superadmin','admin','compliance'].indexOf(currentRole) !== -1);
  var canDefer = (currentRole === 'superadmin');

  var rows = data.docs.map(function(doc) {
    var isCheck = (doc.doc_key || '').indexOf('check_') === 0;
    var bad = doc.result === 'fail';
    var deferInfo = (doc.status === 'deferred' && doc.deferred_until)
      ? '<div class="upload-hint">deferred until ' + new Date(doc.deferred_until).toLocaleDateString('en-NG') + '</div>' : '';
    var noteInfo = doc.notes ? '<div class="upload-hint">' + _escA(doc.notes) + '</div>' : '';
    var subjInfo = doc.subject_name ? '<div class="upload-hint">' + _escA(doc.subject_name) + '</div>' : '';
    var idInfo = doc.id_type ? '<div class="upload-hint">' + _escA(doc.id_type) + ' ' + _escA(doc.id_number || '') + (doc.id_country ? ' · ' + _escA(doc.id_country) : '') + (doc.id_expiry ? ' · exp ' + _escA(doc.id_expiry) : '') + '</div>' : '';
    var comments = Array.isArray(doc.comments) ? doc.comments : [];
    var commentsHtml = comments.length ? '<div style="margin-top:5px">' + comments.map(function(c){
        return '<div class="upload-hint" style="display:flex;gap:6px;align-items:flex-start">&#128172; ' + _escA(c.body) +
          ' <span style="color:var(--gray-400)">&mdash; ' + _escA(String(c.author||'').split('@')[0]) + '</span>' +
          (currentRole === 'superadmin' ? ' <button class="btn btn-outline btn-sm" style="padding:0 6px;line-height:1.4" title="Remove (SA)" onclick="removeDocComment(\'' + c.id + '\')">&times;</button>' : '') +
          '</div>';
      }).join('') + '</div>' : '';
    var result = canEdit ? (
        '<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="setDocResult(\'' + doc.id + '\',\'pass\')">Pass</button> ' +
        '<button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="setDocResult(\'' + doc.id + '\',\'fail\')">Fail</button> ' +
        '<button class="btn btn-outline btn-sm" onclick="setDocResult(\'' + doc.id + '\',\'unknown\')">Unknown</button> ' +
        '<button class="btn btn-outline btn-sm" onclick="addDocComment(\'' + doc.id + '\')">&#128172; Comment</button>'
      ) : '<span style="color:var(--gray-400);font-size:12px">view only</span>';
    var reportInfo = doc.report_file ? '<div class="upload-hint">&#128206; Report: ' + _escA(doc.report_name || 'report') + ' <button class="btn btn-outline btn-sm" style="padding:0 6px" onclick="viewDocReport(\'' + doc.id + '\')">View</button></div>' : '';
    var lifecycle = canEdit ? (
        (isCheck ? '<button class="btn btn-outline btn-sm" onclick="runCheck(\'' + doc.id + '\')">Run check</button> ' : '') +
        '<button class="btn btn-outline btn-sm" onclick="uploadDocReport(\'' + doc.id + '\')">&#128206; ' + (doc.report_file ? 'Replace report' : 'Upload report') + '</button> ' +
        (canDefer ? '<button class="btn btn-outline btn-sm" onclick="deferOneDoc(\'' + doc.id + '\')">Defer</button> ' : '') +
        '<button class="btn btn-outline btn-sm" onclick="requestReupload(\'' + doc.id + '\')">Re-upload</button> ' +
        '<button class="btn btn-outline btn-sm" onclick="setDocStatus(\'' + doc.id + '\',\'waived\')">Waive</button>'
      ) : '';
    return '<tr' + (bad ? ' style="background:#fef2f2"' : '') + '>' +
      (canDefer ? '<td><input type="checkbox" class="doc-cb" value="' + doc.id + '"></td>' : '') +
      '<td style="font-weight:500">' + _escA(doc.doc_label) + (isCheck ? ' <span class="tag">CHECK</span>' : '') + subjInfo + idInfo + deferInfo + noteInfo + reportInfo + commentsHtml + '</td>' +
      '<td>' + docResultBadge(doc.result) + '</td>' +
      '<td style="white-space:nowrap">' + result + (lifecycle ? '<div style="margin-top:4px">' + lifecycle + '</div>' : '') + '</td>' +
    '</tr>';
  }).join('');

  var colspan = canDefer ? 4 : 3;
  showModal(
    '<div class="modal-header"><div class="modal-title">Documents — ' + _escA(name) + '</div>' +
      '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    (canDefer
      ? '<div class="page-desc" style="margin-bottom:10px">Each required document is tracked individually. Tick rows and set a period to defer specific documents and activate the account — an overdue deferral auto-suspends the account so nothing slips.</div>'
      : (canEdit ? '<div class="page-desc" style="margin-bottom:10px">Mark each document submitted/verified/waived. Document deferral is Super-Admin only.</div>'
                 : '<div class="page-desc" style="margin-bottom:10px">Read-only view of the merchant\'s KYC documents.</div>')) +
    uploadedHtml +
    '<div style="font-weight:600;margin:2px 0 6px">Document checklist</div>' +
    '<div class="table-wrap"><table style="width:100%"><thead><tr>' + (canDefer ? '<th></th>' : '') + '<th>Requirement</th><th>Result</th><th>Actions</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + colspan + '" style="text-align:center;color:var(--gray-400);padding:16px">No documents</td></tr>') + '</tbody></table></div>' +
    (canDefer
      ? '<div class="divider"></div>' +
        '<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px;align-items:end">' +
          '<div><label class="form-label">Defer ticked for</label><select class="form-input form-select" id="doc-duration"><option value="1">1 month</option><option value="2">2 months</option><option value="3" selected>3 months</option><option value="6">6 months</option></select></div>' +
          '<div><label class="form-label">Reason</label><input class="form-input" id="doc-reason" placeholder="Reason"></div>' +
          '<div><button class="btn btn-lime" onclick="deferSelectedDocs()">Defer ticked &amp; activate</button></div>' +
        '</div>'
      : '')
  );
}

function docStatusBadge(s) {
  var map = { outstanding:'badge-amber', submitted:'badge-blue', verified:'badge-green', deferred:'badge-purple',
              overdue:'badge-red', waived:'badge-gray', failed:'badge-red', rejected:'badge-red', reupload_requested:'badge-amber' };
  return '<span class="badge ' + (map[s] || 'badge-gray') + '">' + ((s || '—').replace(/_/g,' ')) + '</span>';
}

// Per-requirement KYC verdict: PASS / FAIL / UNKNOWN.
function docResultBadge(r) {
  var m = { pass:'badge-green', fail:'badge-red', unknown:'badge-gray' };
  return '<span class="badge ' + (m[r] || 'badge-gray') + '">' + String(r || 'unknown').toUpperCase() + '</span>';
}
async function setDocResult(docId, result) {
  var res = await apiFetch('/documents/item/' + docId + '/result', { method:'PATCH', body: JSON.stringify({ result: result }) });
  if (res && res.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Failed to set result'));
}
async function addDocComment(docId) {
  var body = prompt('Comment (max 200 characters):', '');
  if (body === null) return;
  body = body.trim(); if (!body) return;
  if (body.length > 200) { alert('Max 200 characters.'); return; }
  var res = await apiFetch('/documents/item/' + docId + '/comment', { method:'POST', body: JSON.stringify({ body: body }) });
  if (res && res.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Failed to add comment'));
}
async function removeDocComment(commentId) {
  if (!confirm('Remove this comment?')) return;
  var res = await apiFetch('/documents/comment/' + commentId, { method:'DELETE' });
  if (res && res.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Failed to remove comment'));
}

// Reviewer uploads a verification report file against a requirement (e.g. address vs utility bill).
function uploadDocReport(docId) {
  var input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*,application/pdf';
  input.onchange = async function() {
    var f = input.files && input.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { alert('Report must be under 5MB.'); return; }
    var fd = new FormData(); fd.append('report', f);
    var token = sessionStorage.getItem('paylode_token');
    try {
      var res = await fetch(API_BASE + '/documents/item/' + docId + '/report', { method:'POST', headers:{ Authorization:'Bearer ' + token }, body: fd });
      var d = await res.json();
      if (res.ok && d.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
      else alert('Error: ' + ((d && d.message) || ('HTTP ' + res.status)));
    } catch (e) { alert('Upload failed: ' + e.message); }
  };
  input.click();
}
async function viewDocReport(docId) {
  var token = sessionStorage.getItem('paylode_token');
  try {
    var res = await fetch(API_BASE + '/documents/item/' + docId + '/report', { headers:{ Authorization:'Bearer ' + token } });
    if (!res.ok) { alert('Could not open report (' + res.status + ')'); return; }
    var blob = await res.blob(); var url = URL.createObjectURL(blob);
    window.open(url, '_blank'); setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
  } catch (e) { alert('Error: ' + e.message); }
}

async function runCheck(docId) {
  var res = await apiFetch('/documents/item/' + docId + '/run-check', { method:'POST' });
  if (res && res.status) { alert(res.message || 'Check queued.'); var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Run check failed'));
}

async function requestReupload(docId) {
  var reason = prompt('Message to the merchant (reason for re-upload):', '');
  if (reason === null) return;
  var res = await apiFetch('/documents/item/' + docId + '/request-reupload', { method:'POST', body: JSON.stringify({ reason: reason }) });
  if (res && res.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Request failed'));
}

async function setDocStatus(docId, status) {
  var res = await apiFetch('/documents/item/' + docId, { method:'PATCH', body: JSON.stringify({ status: status }) });
  if (res && res.status) { var c = window._docCtx; openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Update failed'));
}

// Fetch an uploaded file (auth header can't ride on a plain <a>/window.open, so
// pull it as a blob with the token, then view or download it).
async function _fetchDocBlob(ref, idx) {
  var token = sessionStorage.getItem('paylode_token');
  var res = await fetch(API_BASE + '/documents/file/' + encodeURIComponent(ref) + '/' + idx, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.blob();
}
async function viewUploadedFile(ref, idx) {
  try {
    var blob = await _fetchDocBlob(ref, idx);
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
  } catch (e) { alert('Could not open document: ' + e.message); }
}
async function downloadUploadedFile(ref, idx, name) {
  try {
    var blob = await _fetchDocBlob(ref, idx);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name || 'document';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
  } catch (e) { alert('Could not download document: ' + e.message); }
}

// Defer a SINGLE document (per-row action, SA only).
async function deferOneDoc(docId) {
  var c = window._docCtx;
  var months = prompt('Defer this document for how many months? (1, 2, 3 or 6)', '3');
  if (months === null) return;
  var duration = parseInt(months, 10);
  if ([1,2,3,6].indexOf(duration) === -1) { alert('Duration must be 1, 2, 3 or 6 months.'); return; }
  var reason = prompt('Reason for deferral (optional):', '') || '';
  var res = await apiFetch('/documents/' + c.entityType + '/' + c.id + '/defer', {
    method:'POST', body: JSON.stringify({ doc_ids: [docId], duration_months: duration, reason: reason })
  });
  if (res && res.status) { alert(res.message || 'Document deferred.'); openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Deferral failed'));
}

async function deferSelectedDocs() {
  var c = window._docCtx;
  var ids = Array.prototype.slice.call(document.querySelectorAll('.doc-cb:checked')).map(function(x){ return x.value; });
  if (!ids.length) { alert('Tick at least one document to defer.'); return; }
  var duration = parseInt(document.getElementById('doc-duration').value, 10);
  var reason = (document.getElementById('doc-reason') || {}).value || '';
  var res = await apiFetch('/documents/' + c.entityType + '/' + c.id + '/defer', {
    method:'POST', body: JSON.stringify({ doc_ids: ids, duration_months: duration, reason: reason })
  });
  if (res && res.status) { alert(res.message || 'Deferred.'); openDocsModal(c.entityType, c.id, c.name); }
  else alert('Error: ' + ((res && res.message) || 'Deferral failed'));
}

(function initRole() {
  var token = sessionStorage.getItem('paylode_token');
  if (!token) { window.location.href = '/login.html'; return; }
  try {
    var user = JSON.parse(sessionStorage.getItem('paylode_user') || '{}');
    var _r = (user.role || '').toUpperCase();
    if      (_r === 'SUPER_ADMIN')        currentRole = 'superadmin';
    else if (_r === 'ADMIN')              currentRole = 'admin';
    else if (_r === 'COMPLIANCE_OFFICER') currentRole = 'compliance';
    else if (_r === 'AUDIT')              currentRole = 'audit';
    else if (_r === 'AGGREGATOR')         currentRole = 'aggregator';
    else if (_r === 'MERCHANT')           currentRole = 'merchant';
    // Super admins may use ?role= to preview other role views for testing
    if (currentRole === 'superadmin') {
      var urlRole = new URLSearchParams(window.location.search).get('role');
      if (urlRole === 'aggregator') currentRole = 'aggregator';
      if (urlRole === 'admin')      currentRole = 'admin';
      if (urlRole === 'merchant')   currentRole = 'merchant';
      if (urlRole === 'compliance') currentRole = 'compliance';
      if (urlRole === 'audit')      currentRole = 'audit';
    }
  } catch(e) {}
})();
