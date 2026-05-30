// ─────────────────────────────────────────────────────────────────────────────
// PAYLODE — Live API Wiring
// Overrides all hardcoded render functions with live API data
// ─────────────────────────────────────────────────────────────────────────────

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
      <button class="btn btn-primary" onclick="showModal('onboard')">+ Onboard Merchant</button>
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
