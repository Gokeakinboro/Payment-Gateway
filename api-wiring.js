// ─────────────────────────────────────────────────────────────────────────────
// PAYLODE — Live API Wiring
// Overrides all hardcoded render functions with live API data
// ─────────────────────────────────────────────────────────────────────────────

function getToken(){ return localStorage.getItem('paylode_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('paylode_user')||'{}'); }catch{ return {}; } }
function logout(){ localStorage.removeItem('paylode_token'); localStorage.removeItem('paylode_user'); window.location.href='/login.html'; }


// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtNaira(kobo) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(Number(kobo) / 100);
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

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Platform Overview</div>
      <div class="page-desc">Live data — ${new Date().toLocaleDateString('en-NG',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--lime)"></span>Today Volume</div>
        <div class="stat-value">${fmtNaira(d.today.volume*100)}</div>
        <div class="stat-sub">${fmtNum(d.today.txn_count)} transactions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label"><span class="dot" style="background:var(--blue)"></span>Today Net Revenue</div>
        <div class="stat-value">${fmtNaira(d.today.paylode_net*100)}</div>
        <div class="stat-sub">Fees: ${fmtNaira(d.today.fees*100)}</div>
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
    <div class="grid-2">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Month to Date</div><div class="card-subtitle">Current month performance</div></div>
        </div>
        <div class="rev-row"><span class="rev-label">Total Volume</span><span class="rev-value">${fmtNaira(d.mtd.volume*100)}</span></div>
        <div class="rev-row"><span class="rev-label">Gross Fees</span><span class="rev-value">${fmtNaira(d.mtd.fees*100)}</span></div>
        <div class="rev-row"><span class="rev-label">Transactions</span><span class="rev-value">${fmtNum(d.mtd.txn_count)}</span></div>
        <div class="rev-net">
          <span style="font-weight:600;font-size:13px;color:#166534">Paylode Net Margin</span>
          <span style="font-weight:800;font-size:18px;color:#166534">${fmtNaira(d.mtd.paylode_net*100)}</span>
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
              ${rows.length ? rows.map(t => `<tr>
                <td class="mono" style="font-size:11px">${t.reference}</td>
                <td>${fmtNaira(t.amount)}</td>
                <td><span class="tag">${t.channel}</span></td>
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
async function loadTransactions(page=1, filters={}) {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    let url = `/transactions?page=${page}&perPage=20`;
    if (filters.status)  url += `&status=${filters.status}`;
    if (filters.channel) url += `&channel=${filters.channel}`;
    if (filters.from)    url += `&from=${filters.from}`;
    if (filters.to)      url += `&to=${filters.to}`;

    const res = await apiFetch(url);
    if (!res?.data) { el.innerHTML = errorBox('Could not load transactions'); return; }

    const { data: txns, meta } = res.data;

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">All Transactions</div><div class="page-desc">${fmtNum(meta.total)} total transactions</div></div>
      <div class="flex">
        <select class="form-input form-select" style="width:130px;margin-right:8px" onchange="loadTransactions(1,{status:this.value})">
          <option value="">All Status</option>
          <option value="SUCCESS">Success</option>
          <option value="FAILED">Failed</option>
          <option value="PENDING">Pending</option>
          <option value="REVERSED">Reversed</option>
        </select>
        <select class="form-input form-select" style="width:140px" onchange="loadTransactions(1,{channel:this.value})">
          <option value="">All Channels</option>
          <option value="CARD">Card</option>
          <option value="BANK_TRANSFER">Bank Transfer</option>
          <option value="USSD">USSD</option>
        </select>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Fee</th><th>Channel</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${txns.length ? txns.map(t => `<tr>
              <td class="mono" style="font-size:11px">${t.reference}</td>
              <td>${t.merchant?.businessName||'—'}</td>
              <td style="font-weight:600">${fmtNaira(t.amount)}</td>
              <td class="mono" style="font-size:12px">${fmtNaira(t.fees?.merchant_fee||0)}</td>
              <td><span class="tag">${t.channel}</span></td>
              <td>${statusBadge(t.status)}</td>
              <td style="font-size:12px;color:var(--gray-400)">${new Date(t.created_at).toLocaleDateString('en-NG')}</td>
            </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No transactions found</td></tr>'}
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
      <div style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" onclick="copyAdminSignupLink()">Copy Sign-Up Link</button><button class="btn btn-primary" onclick="showModal('onboard')">+ Onboard Merchant</button></div>
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
              <td><button class="btn btn-outline btn-sm" onclick="viewMerchant('${m.id}')">View</button></td>
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

// ── AGGREGATORS ───────────────────────────────────────────────────────────────
async function loadAggregators() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const res = await apiFetch('/aggregators');
    if (!res?.data) { el.innerHTML = errorBox('Could not load aggregators'); return; }

    const aggs = res.data;

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Aggregators</div>
      <div class="page-desc">${aggs.length} active aggregator partners</div>
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
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn btn-outline btn-sm" onclick="editSplit('${a.id}','${a.revenueSplitPct}')">Edit Split</button>
          <button class="btn btn-outline btn-sm" onclick="viewAggMerchants('${a.id}')">View Merchants</button>
        </div>
      </div>`).join('')}
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load aggregators: ' + e.message);
  }
}

// ── KYC / COMPLIANCE QUEUE ────────────────────────────────────────────────────
async function loadCompliance() {
  const el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();

  try {
    const [queue, flags] = await Promise.all([
      apiFetch('/kyc/queue?status=submitted&perPage=20'),
      apiFetch('/reports/aml-flags?riskLevel=HIGH'),
    ]);

    const submissions = queue?.data?.submissions || [];
    const amlFlags    = flags?.data || [];

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Compliance</div>
      <div class="page-desc">KYC review queue and AML monitoring</div>
    </div>
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchTab(this,'kyc-panel','aml-panel')">KYC Queue (${submissions.length})</button>
      <button class="tab-btn" onclick="switchTab(this,'aml-panel','kyc-panel')">AML Flags (${amlFlags.length})</button>
    </div>
    <div id="kyc-panel">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Merchant</th><th>Category</th><th>Tier</th><th>Aggregator</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>
              ${submissions.length ? submissions.map(s => `<tr>
                <td><div style="font-weight:500">${s.merchant.name}</div><div style="font-size:11px;color:var(--gray-400)">${s.merchant.code}</div></td>
                <td>${s.merchant.category}</td>
                <td><span class="badge badge-blue">Tier ${s.tier_applied}</span></td>
                <td>${s.merchant.aggregator||'Direct'}</td>
                <td style="font-size:12px">${new Date(s.submitted_at).toLocaleDateString('en-NG')}</td>
                <td>
                  <button class="btn btn-lime btn-sm" onclick="approveKyc('${s.id}')">Approve</button>
                  <button class="btn btn-outline btn-sm" onclick="rejectKyc('${s.id}')">Reject</button>
                </td>
              </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:20px">No pending KYC submissions</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div id="aml-panel" style="display:none">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Merchant</th><th>Flag Type</th><th>Risk Level</th><th>Transaction</th><th>Description</th><th>Raised</th></tr></thead>
            <tbody>
              ${amlFlags.length ? amlFlags.map(f => `<tr>
                <td style="font-weight:500">${f.merchant?.businessName||'—'}</td>
                <td><span class="tag">${f.flag_type}</span></td>
                <td>${statusBadge(f.risk_level?.toLowerCase())}</td>
                <td class="mono" style="font-size:11px">${f.transaction?.reference||'—'}</td>
                <td style="font-size:12px">${f.description||'—'}</td>
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

    const rows = rev?.data?.data || [];
    const aggRows = agg?.data?.data || [];

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Revenue Configuration & Reports</div>
      <div class="page-desc">Current month — ${from} to ${to}</div>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div class="card-title">Monthly Revenue Breakdown</div></div>
        ${rows.length ? rows.slice(0,10).map(r => `
        <div class="rev-row">
          <span class="rev-label">${r.period?.slice(0,10)||'—'} · ${r.channel}</span>
          <div style="text-align:right">
            <div style="font-weight:600;font-size:13px">${fmtNaira(r.gross_revenue*100)}</div>
            <div style="font-size:11px;color:var(--gray-400)">Margin: ${fmtNaira(r.paylode_margin*100)}</div>
          </div>
        </div>`).join('') : '<div style="color:var(--gray-400);padding:16px;text-align:center">No revenue data yet</div>'}
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Aggregator Revenue Share</div></div>
        ${aggRows.length ? aggRows.map(a => `
        <div class="rev-row">
          <div>
            <div style="font-weight:500;font-size:13px">${a.company_name}</div>
            <div style="font-size:11px;color:var(--gray-400)">${a.split_pct} split · ${a.merchant_count} merchants</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600;font-size:13px">${fmtNaira(a.agg_payout_due*100)}</div>
            <div style="font-size:11px;color:var(--gray-400)">Due this month</div>
          </div>
        </div>`).join('') : '<div style="color:var(--gray-400);padding:16px;text-align:center">No aggregator data yet</div>'}
      </div>
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

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Settlements</div><div class="page-desc">Merchant disbursement records</div></div>
      <button class="btn btn-primary" onclick="runSettlement()">Run Settlement Batch</button>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Merchant</th><th>Period</th><th>Gross</th><th>Fees</th><th>Net Settled</th><th>Txns</th><th>Status</th></tr></thead>
          <tbody>
            ${settlements.length ? settlements.map(s => `<tr>
              <td style="font-weight:500">${s.merchant?.businessName||'—'}</td>
              <td style="font-size:12px">${s.periodStart?.slice(0,10)||'—'}</td>
              <td>${fmtNaira(s.grossAmount)}</td>
              <td>${fmtNaira(s.feesDeducted)}</td>
              <td style="font-weight:600">${fmtNaira(s.netSettled)}</td>
              <td>${s.txnCount}</td>
              <td>${statusBadge(s.status?.toLowerCase())}</td>
            </tr>`).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No settlements yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
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

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Merchant Dashboard</div>
      <div class="page-desc">${s?.merchant?.businessName||user.firstName} — ${from} to ${to}</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Collections This Month</div><div class="stat-value">${fmtNaira((s?.summary?.total_collections||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Fees Paid</div><div class="stat-value">${fmtNaira((s?.summary?.total_fees_paid||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Net Settled</div><div class="stat-value">${fmtNaira((s?.summary?.net_settled||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Transactions</div><div class="stat-value">${fmtNum(s?.summary?.successful_transactions||0)}</div></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Recent Transactions</div><button class="btn btn-outline btn-sm" onclick="navigate('merch_transactions')">View All</button></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Reference</th><th>Amount</th><th>Fee</th><th>Channel</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${(txns?.data?.data||[]).map(t=>`<tr>
              <td class="mono" style="font-size:11px">${t.reference}</td>
              <td style="font-weight:600">${fmtNaira(t.amount)}</td>
              <td>${fmtNaira(t.fees?.merchant_fee||0)}</td>
              <td><span class="tag">${t.channel}</span></td>
              <td>${statusBadge(t.status)}</td>
              <td style="font-size:12px">${new Date(t.created_at).toLocaleDateString('en-NG')}</td>
            </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--gray-400)">No transactions yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load merchant data: ' + e.message);
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
    const myRevenue   = revenue?.data || [];
    const latestMonth = myRevenue[0];

    el.innerHTML = `
    <div class="page-header">
      <div class="page-title">Aggregator Dashboard</div>
      <div class="page-desc">${myMerchants.length} merchants under your portfolio</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Active Merchants</div><div class="stat-value">${myMerchants.filter(m=>m.isActive).length}</div></div>
      <div class="stat-card"><div class="stat-label">This Month Revenue Share</div><div class="stat-value">${fmtNaira((latestMonth?.agg_share_naira||0)*100)}</div></div>
      <div class="stat-card"><div class="stat-label">Pending KYC</div><div class="stat-value">${myMerchants.filter(m=>m.kycStatus==='KYC_IN_REVIEW').length}</div></div>
      <div class="stat-card"><div class="stat-label">Payout Status</div><div class="stat-value" style="font-size:16px">${latestMonth?.status||'—'}</div></div>
    </div>
    <div class="card">
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

// ── SETTLEMENT BATCH ──────────────────────────────────────────────────────────
async function runSettlement() {
  if (!confirm('Run settlement batch for yesterday? This will create settlement records for all active merchants.')) return;
  const res = await apiFetch('/settlements/process', { method: 'POST' });
  if (res?.status) {
    alert(`Settlement complete: ${res.data.processed} batches created`);
    loadSettlements();
  } else {
    alert('Error: ' + (res?.message || 'Settlement failed'));
  }
}

// ── AGGREGATOR SPLIT EDIT ─────────────────────────────────────────────────────
async function editSplit(id, currentSplit) {
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

// ── NAVIGATE FUNCTION ─────────────────────────────────────────────────────────
function navigate(page) {
  currentPage = page;
  renderNav();
  loadPageData(page);
}

// ── CENTRAL PAGE LOADER ────────────────────────────────────────────────────────
function loadPageData(page) {
  const role = currentRole;
  switch(page) {
    case 'overview':
      if (role === 'superadmin') loadSuperOverview();
      else if (role === 'aggregator') loadAggOverview();
      else if (role === 'merchant') loadMerchantOverview();
      break;
    case 'agg_overview':     loadAggOverview(); break;
    case 'transactions':     loadTransactions(); break;
    case 'merchants':        loadMerchants(); break;
    case 'aggregators':      loadAggregators(); break;
    case 'compliance':       loadCompliance(); break;
    case 'revenue':          loadRevenueReport(); break;
    case 'settlement':       loadSettlements(); break;
    case 'merch_overview':   loadMerchantOverview(); break;
    case 'agg_merchants':
      apiFetch('/aggregators/my/merchants').then(r => {
        const el = document.getElementById('main-content');
        const merchants = r?.data || [];
        el.innerHTML = `<div class="page-header"><div class="page-title">My Merchants</div></div>
        <div class="card"><div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Category</th><th>KYC Status</th><th>Rate</th></tr></thead>
          <tbody>${merchants.map(m=>`<tr><td>${m.businessName}</td><td>${m.category}</td><td>${statusBadge(m.kycStatus)}</td><td>${m.processingRate?(Number(m.processingRate)*100).toFixed(1)+'%':'—'}</td></tr>`).join('')}</tbody>
        </table></div></div>`;
      });
      break;
    default:
      document.getElementById('main-content').innerHTML = `<div class="page-header"><div class="page-title">${page}</div></div><div class="card"><div class="info-box">This section is coming soon.</div></div>`;
  }
}

// ── OVERRIDE renderPage TO USE LIVE DATA ──────────────────────────────────────
const _origRenderPage = typeof renderPage === 'function' ? renderPage : null;
function renderPage() {
  if (_origRenderPage) _origRenderPage();
  setTimeout(() => loadPageData(currentPage), 50);
}

// ── LOAD USER INFO IN TOPBAR ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  const user = getUser();
  if (user.firstName) {
    const initials = (user.firstName[0] + (user.lastName?.[0]||'')).toUpperCase();
    const av = document.getElementById('user-avatar');
    if (av) { av.textContent = initials; av.title = 'Click to sign out'; }
    const ub = document.getElementById('topbar-user');
    if (ub) ub.textContent = user.firstName + ' ' + (user.lastName||'');
  }
  // Set correct role from JWT
  const role = user.role;
  if (role === 'SUPER_ADMIN' || role === 'COMPLIANCE_OFFICER') currentRole = 'superadmin';
  else if (role === 'AGGREGATOR') currentRole = 'aggregator';
  else if (role === 'MERCHANT')   currentRole = 'merchant';
  renderNav();
  loadPageData(currentPage);
});

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
          <div class="stat-value" style="font-size:20px">${fmtNaira((w.balance||0)*100)}</div>
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
  const formArea = document.getElementById('payout-form-area');
  formArea.innerHTML = `
  <div class="card">
    <div class="card-header"><div class="card-title">Create New Payout Batch</div></div>
    <div class="tab-nav">
      <button class="tab-btn active" onclick="switchTab(this,'manual-tab','upload-tab')">Manual Entry</button>
      <button class="tab-btn" onclick="switchTab(this,'upload-tab','manual-tab')">CSV Upload</button>
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
          <div class="form-group" style="margin:0"><label class="form-label">Narration</label><input class="form-input ben-narration" placeholder="Optional"></div>
        </div>
      </div>
      <div class="flex" style="gap:8px;margin-top:8px">
        <button class="btn btn-outline btn-sm" onclick="addBeneficiaryRow()">+ Add Row</button>
        <button class="btn btn-primary" onclick="submitManualPayout()">Submit Payout Batch</button>
      </div>
    </div>
    <div id="upload-tab" style="display:none">
      <div class="info-box" style="margin-bottom:16px;font-size:12px">
        CSV format: <strong>account_number, bank_code, amount_naira, narration</strong><br>
        Example: 0123456789, 058, 5000, Salary payment
      </div>
      <div class="form-group"><label class="form-label">Upload CSV File</label>
        <input type="file" accept=".csv" id="payout-csv" class="form-input" onchange="previewCsv(this)">
      </div>
      <div id="csv-preview"></div>
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

async function previewCsv(input) {
  const file = input.files[0]; if (!file) return;
  const form = new FormData(); form.append('file', file);
  const token = getToken();
  const res = await fetch('/api/v1/payouts/batches/upload', { method:'POST', headers:{'Authorization':'Bearer '+token}, body: form });
  const data = await res.json();
  const preview = document.getElementById('csv-preview');
  if (data.status) {
    preview.innerHTML = `<div class="info-box" style="margin:12px 0">${data.data.total_items} beneficiaries parsed — Total: ₦${data.data.total_amount_naira?.toLocaleString()}</div>
    <button class="btn btn-primary" onclick="submitCsvPayout(${JSON.stringify(data.data.items).replace(/"/g,'&quot;')})">Confirm & Submit Batch</button>`;
  } else {
    preview.innerHTML = `<div class="warn-box">${data.message}<br>${(data.errors||[]).slice(0,5).join('<br>')}</div>`;
  }
}

async function submitCsvPayout(items) {
  const desc = prompt('Batch description (optional):') || '';
  const res = await apiFetch('/payouts/batches', { method:'POST', body: JSON.stringify({ description: desc, items }) });
  if (res?.status) { alert(`Batch created! ${res.data.total_items} payments, ${res.data.total_amount}`); loadPayouts(); }
  else alert('Error: ' + (res?.message||'Failed'));
}

async function viewBatch(id) {
  const res = await apiFetch(`/payouts/batches/${id}`);
  if (!res?.data) return;
  const { batch, items } = res.data;
  const el = document.getElementById('main-content');
  el.innerHTML = `
  <div class="page-header flex-between">
    <div><div class="page-title">Payout Batch — ${batch.batch_ref}</div><div class="page-desc">${batch.description||''}</div></div>
    <div class="flex" style="gap:8px">
      ${statusBadge(batch.status)}
      <button class="btn btn-outline btn-sm" onclick="loadPayouts()">← Back</button>
    </div>
  </div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total Amount</div><div class="stat-value">${fmtNaira(batch.total_amount)}</div></div>
    <div class="stat-card"><div class="stat-label">Total Items</div><div class="stat-value">${batch.total_items}</div></div>
    <div class="stat-card"><div class="stat-label">Processed</div><div class="stat-value" style="color:var(--green)">${batch.processed_items}</div></div>
    <div class="stat-card"><div class="stat-label">Failed</div><div class="stat-value" style="color:var(--red)">${batch.failed_items}</div></div>
  </div>
  <div class="card">
    <div class="table-wrap"><table>
      <thead><tr><th>Account</th><th>Bank</th><th>Amount</th><th>Narration</th><th>Status</th><th>Failure Reason</th></tr></thead>
      <tbody>
        ${items.map(i=>`<tr>
          <td class="mono">${i.account_number}</td>
          <td>${i.bank_name||i.bank_code}</td>
          <td>${fmtNaira(i.amount)}</td>
          <td>${i.narration||'—'}</td>
          <td>${statusBadge(i.status)}</td>
          <td style="font-size:12px;color:var(--red)">${i.failure_reason||'—'}</td>
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

// ── RAIL MANAGEMENT ───────────────────────────────────────────────────────────
async function loadRails() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const [rails, types] = await Promise.all([
      apiFetch('/rails'),
      apiFetch('/rails/service-types'),
    ]);
    const railList = rails?.data || [];
    const typeList = types?.data || [];

    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Payment Rails</div><div class="page-desc">Manage rails, service types, fee caps, and VAT</div></div>
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
        <thead><tr><th>Service Type</th><th>Rate</th><th>Rail Fee Cap</th><th>Merchant Cap</th><th>VAT Rate</th><th>Actions</th></tr></thead>
        <tbody>
          ${(rail.costs||[]).length ? rail.costs.map(c=>`<tr>
            <td><span class="tag">${c.service_type||'—'}</span></td>
            <td class="mono">${(Number(c.rate||0)*100).toFixed(3)}%</td>
            <td>${Number(c.fee_cap||0)>0?fmtNaira(c.fee_cap):'No cap'}</td>
            <td>${Number(c.merchant_cap||0)>0?fmtNaira(c.merchant_cap):'No cap'}</td>
            <td>${(Number(c.vat_rate||0.075)*100).toFixed(1)}%</td>
            <td><button class="btn btn-outline btn-sm" onclick="editRailCost('${rail.id}','${c.service_type}',${c.rate},${c.fee_cap||0},${c.merchant_cap||0},${c.vat_rate||0.075})">Edit</button></td>
          </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--gray-400);padding:12px">No costs configured — click Add Service Type</td></tr>'}
        </tbody>
      </table></div>
      <div style="margin-top:12px">
        <button class="btn btn-outline btn-sm" onclick="showAddServiceType('${rail.id}')">+ Add Service Type</button>
        <button class="btn btn-outline btn-sm" onclick="testRouting('${rail.id}')">Test Routing</button>
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

function showAddServiceType(railId) {
  const types = ['VISA','MASTERCARD','VERVE','BANK_TRANSFER','USSD','PAYOUT'];
  document.getElementById('rail-form-area').innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="card-title" style="margin-bottom:12px">Add Service Type to Rail</div>
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Service Type</label>
        <select class="form-input form-select" id="st-type">
          ${types.map(t=>`<option value="${t}">${t.replace(/_/g,' ')}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Rate (e.g. 0.015 for 1.5%)</label><input class="form-input" id="st-rate" type="number" step="0.001" placeholder="0.015"></div>
      <div class="form-group"><label class="form-label">Rail Fee Cap (₦, 0 = no cap)</label><input class="form-input" id="st-cap" type="number" placeholder="800" value="0"></div>
      <div class="form-group"><label class="form-label">Merchant Cap (₦, 0 = no cap)</label><input class="form-input" id="st-mcap" type="number" placeholder="2000" value="0"></div>
      <div class="form-group"><label class="form-label">VAT Rate (default 0.075)</label><input class="form-input" id="st-vat" type="number" step="0.001" value="0.075"></div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="submitServiceType('${railId}')">Save</button>
    <button class="btn btn-outline btn-sm" onclick="document.getElementById('rail-form-area').innerHTML=''">Cancel</button>
  </div>`;
}

async function submitServiceType(railId) {
  const rate  = parseFloat(document.getElementById('st-rate').value);
  const cap   = parseFloat(document.getElementById('st-cap').value) * 100; // naira to kobo
  const mcap  = parseFloat(document.getElementById('st-mcap').value) * 100;
  const vat   = parseFloat(document.getElementById('st-vat').value);
  const type  = document.getElementById('st-type').value;
  if (isNaN(rate)) { alert('Valid rate required'); return; }
  const res = await apiFetch(`/rails/${railId}/costs`, {
    method: 'PUT',
    body: JSON.stringify({ service_type: type, rate, fee_cap: Math.round(cap), merchant_cap: Math.round(mcap), vat_rate: vat }),
  });
  if (res?.status) { alert('Service type saved'); loadRails(); }
  else alert('Error: ' + (res?.message||'Failed'));
}

function editRailCost(railId, type, rate, cap, mcap, vat) {
  document.getElementById('rail-form-area').innerHTML = `
  <div class="card" style="margin-bottom:16px">
    <div class="card-title" style="margin-bottom:12px">Edit ${type.replace(/_/g,' ')} Cost</div>
    <div class="form-grid">
      <div class="form-group"><label class="form-label">Rate</label><input class="form-input" id="st-rate" type="number" step="0.001" value="${rate}"></div>
      <div class="form-group"><label class="form-label">Rail Fee Cap (₦)</label><input class="form-input" id="st-cap" type="number" value="${Number(cap)/100}"></div>
      <div class="form-group"><label class="form-label">Merchant Cap (₦)</label><input class="form-input" id="st-mcap" type="number" value="${Number(mcap)/100}"></div>
      <div class="form-group"><label class="form-label">VAT Rate</label><input class="form-input" id="st-vat" type="number" step="0.001" value="${vat}"></div>
      <input type="hidden" id="st-type" value="${type}">
    </div>
    <button class="btn btn-primary btn-sm" onclick="submitServiceType('${railId}')">Update</button>
    <button class="btn btn-outline btn-sm" onclick="document.getElementById('rail-form-area').innerHTML=''">Cancel</button>
  </div>`;
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
async function loadWallets() {
  const el = document.getElementById('main-content');
  el.innerHTML = loading();
  try {
    const res = await apiFetch('/payouts/admin/wallets');
    const wallets = res?.data || [];
    el.innerHTML = `
    <div class="page-header flex-between">
      <div><div class="page-title">Merchant Wallets</div><div class="page-desc">Fund merchant payout wallets</div></div>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Merchant</th><th>Code</th><th>Balance</th><th>Last Funded</th><th>Actions</th></tr></thead>
        <tbody>
          ${wallets.length ? wallets.map(w=>`<tr>
            <td style="font-weight:500">${w.business_name}</td>
            <td class="mono" style="font-size:11px">${w.merchant_code}</td>
            <td style="font-weight:600;color:${Number(w.balance)>0?'var(--green)':'var(--red)'}">${fmtNaira(w.balance)}</td>
            <td style="font-size:12px">${w.last_funded_at?new Date(w.last_funded_at).toLocaleDateString('en-NG'):'Never'}</td>
            <td><button class="btn btn-lime btn-sm" onclick="fundWallet('${w.merchant_id}','${w.business_name}')">Fund Wallet</button>
            <button class="btn btn-outline btn-sm" onclick="viewLedger('${w.merchant_id}')">Ledger</button></td>
          </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--gray-400)">No merchant wallets found</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
  } catch(e){ el.innerHTML = errorBox('Failed: '+e.message); }
}

async function fundWallet(merchantId, name) {
  const amount    = prompt(`Fund wallet for ${name}\nAmount to credit (₦):`);
  if (!amount) return;
  const reference = prompt('Payment reference (bank transfer ref):');
  if (!reference) return;
  const desc      = prompt('Description (optional):') || '';
  const res = await apiFetch('/payouts/wallet/fund', {
    method: 'POST',
    body: JSON.stringify({ merchant_id: merchantId, amount: Math.round(parseFloat(amount)*100), reference, description: desc }),
  });
  if (res?.status) { alert(`✓ ${res.data.amount_credited} credited to ${name}\nNew balance: ${res.data.new_balance}`); loadWallets(); }
  else alert('Error: ' + (res?.message||'Failed'));
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
  var el = document.getElementById('main-content');
  var user = getUser();
  var aggId = encodeURIComponent((user && (user.id || user.merchantId)) || 'staff');
  var formUrl = '/onboarding.html?type=merchant&ref=' + aggId + '&via=staff';

  el.innerHTML =
    '<div class="page-header">' +
      '<div class="page-title">Onboard New Merchant</div>' +
      '<div class="page-desc">Fill the form on behalf of the merchant, or send them a personal sign-up link</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:860px">' +

      '<div class="card" style="border:2px solid #7dc534">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128221;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Fill Form Now</div>' +
        '<div class="card-sub" style="margin-bottom:20px">Open the full merchant onboarding form and fill it on behalf of the merchant. Ideal for in-person or phone-assisted onboarding for customers who need help.</div>' +
        '<button class="btn btn-lime" style="width:100%" id="open-form-btn">Open Onboarding Form &rarr;</button>' +
        '<div style="font-size:12px;color:var(--gray-400);margin-top:10px;text-align:center">Opens in a new tab &middot; includes agreement &amp; digital signature</div>' +
      '</div>' +

      '<div class="card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128231;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Send Email Invite</div>' +
        '<div class="card-sub" style="margin-bottom:16px">Send the merchant a personal sign-up link by email. They complete the form themselves at their convenience.</div>' +
        '<div id="inv-alert"></div>' +
        '<div class="form-group"><label class="form-label">Merchant Name <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="inv-name" placeholder="e.g. Zenith Supermarket Ltd"></div>' +
        '<div class="form-group"><label class="form-label">Email Address <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="inv-email" type="email" placeholder="merchant@business.com"></div>' +
        '<div class="form-group"><label class="form-label">Phone Number</label>' +
          '<input class="form-input" id="inv-phone" placeholder="+234 800 000 0000"></div>' +
        '<div class="form-group"><label class="form-label">Business Address</label>' +
          '<input class="form-input" id="inv-address" placeholder="Street, City, State"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:4px" id="inv-btn">Send Invite Email</button>' +
      '</div>' +

    '</div>';

  document.getElementById('open-form-btn').addEventListener('click', function() {
    window.open(formUrl, '_blank');
  });

  document.getElementById('inv-btn').addEventListener('click', function() {
    var name    = document.getElementById('inv-name').value.trim();
    var email   = document.getElementById('inv-email').value.trim();
    var phone   = document.getElementById('inv-phone').value.trim();
    var address = document.getElementById('inv-address').value.trim();
    var alertEl = document.getElementById('inv-alert');
    var btn     = document.getElementById('inv-btn');

    if (!name || !email) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Merchant name and email are required.</div>';
      return;
    }
    btn.textContent = 'Sending...';
    btn.disabled = true;

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
      btn.textContent = 'Send Invite Email';
      btn.disabled = false;
    }).catch(function(e) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Error: ' + e.message + '</div>';
      btn.textContent = 'Send Invite Email';
      btn.disabled = false;
    });
  });
}

async function loadAdminOnboard() {
  var el = document.getElementById('main-content');
  var formUrl = '/onboarding.html?via=admin';

  el.innerHTML =
    '<div class="page-header">' +
      '<div class="page-title">Onboard New Merchant</div>' +
      '<div class="page-desc">Fill the form on behalf of the merchant, or send them a personal sign-up link</div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:860px">' +

      '<div class="card" style="border:2px solid #7dc534">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128221;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Fill Form Now</div>' +
        '<div class="card-sub" style="margin-bottom:20px">Open the full merchant onboarding form and fill it on behalf of the merchant. Ideal for in-person or phone-assisted onboarding for customers who need help.</div>' +
        '<button class="btn btn-lime" style="width:100%" id="adm-open-form-btn">Open Onboarding Form &rarr;</button>' +
        '<div style="font-size:12px;color:var(--gray-400);margin-top:10px;text-align:center">Opens in a new tab &middot; includes agreement &amp; digital signature</div>' +
      '</div>' +

      '<div class="card">' +
        '<div style="font-size:28px;margin-bottom:12px">&#128231;</div>' +
        '<div class="card-title" style="margin-bottom:8px">Send Email Invite</div>' +
        '<div class="card-sub" style="margin-bottom:16px">Send the merchant a personal sign-up link by email. They complete the form themselves at their convenience.</div>' +
        '<div id="adm-inv-alert"></div>' +
        '<div class="form-group"><label class="form-label">Merchant Name <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="adm-inv-name" placeholder="e.g. Zenith Supermarket Ltd"></div>' +
        '<div class="form-group"><label class="form-label">Email Address <span style="color:var(--red)">*</span></label>' +
          '<input class="form-input" id="adm-inv-email" type="email" placeholder="merchant@business.com"></div>' +
        '<div class="form-group"><label class="form-label">Phone Number</label>' +
          '<input class="form-input" id="adm-inv-phone" placeholder="+234 800 000 0000"></div>' +
        '<button class="btn btn-primary" style="width:100%;margin-top:4px" id="adm-inv-btn">Send Invite Email</button>' +
      '</div>' +

    '</div>';

  document.getElementById('adm-open-form-btn').addEventListener('click', function() {
    window.open(formUrl, '_blank');
  });

  document.getElementById('adm-inv-btn').addEventListener('click', function() {
    var name    = document.getElementById('adm-inv-name').value.trim();
    var email   = document.getElementById('adm-inv-email').value.trim();
    var phone   = document.getElementById('adm-inv-phone').value.trim();
    var alertEl = document.getElementById('adm-inv-alert');
    var btn     = document.getElementById('adm-inv-btn');

    if (!name || !email) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Merchant name and email are required.</div>';
      return;
    }
    btn.textContent = 'Sending...';
    btn.disabled = true;

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
        alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">' + ((res && res.message) || 'Failed to send invite.') + '</div>';
      }
      btn.textContent = 'Send Invite Email';
      btn.disabled = false;
    }).catch(function(e) {
      alertEl.innerHTML = '<div class="warn-box" style="margin-bottom:12px">Error: ' + e.message + '</div>';
      btn.textContent = 'Send Invite Email';
      btn.disabled = false;
    });
  });
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
  switch(page) {
    case 'agg_onboard':     loadAggOnboard(); break;
    case 'admin_onboard':   loadAdminOnboard(); break;
    case 'payouts':         loadPayouts(); break;
    case 'rails':           loadRails(); break;
    case 'wallets':         loadWallets(); break;
    case 'product_revenue': loadProductRevenue(); break;
    default: _origLoadPageData(page);
  }
};
(function initRole() {
  const token = localStorage.getItem('paylode_token');
  if (!token) { window.location.href = '/login.html'; return; }
  try {
    const user = JSON.parse(localStorage.getItem('paylode_user') || '{}');
    if (user.role === 'SUPER_ADMIN' || user.role === 'COMPLIANCE_OFFICER') currentRole = 'superadmin';
    else if (user.role === 'AGGREGATOR') currentRole = 'aggregator';
    else if (user.role === 'MERCHANT')   currentRole = 'merchant';
    const urlRole = new URLSearchParams(window.location.search).get('role');
    if (urlRole === 'aggregator') currentRole = 'aggregator';
    if (urlRole === 'merchant')   currentRole = 'merchant';
  } catch(e) {}
})();
