// ─────────────────────────────────────────────────────────────────────────────
// PAYLODE — Live API Wiring
// Overrides all hardcoded render functions with live API data
// ─────────────────────────────────────────────────────────────────────────────

function getToken(){ return localStorage.getItem('paylode_token'); }
function getUser(){ try{ return JSON.parse(localStorage.getItem('paylode_user')||'{}'); }catch(e){ return {}; } }
function logout(){
  localStorage.removeItem('paylode_token');
  localStorage.removeItem('paylode_user');
  localStorage.removeItem('paylode_selected_role');
  window.location.href='/index.html';
}


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
              <td style="white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="viewMerchant('${m.id}')">View</button>&nbsp;
                ${m.isActive
                  ? `<button class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)" onclick="suspendMerchant('${m.id}','${m.businessName}')">Suspend</button>`
                  : `<button class="btn btn-outline btn-sm" style="color:var(--green);border-color:var(--green)" onclick="activateMerchant('${m.id}','${m.businessName}')">Activate</button>`}
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

  var overviewHtml =
    '<div class="rev-row"><span class="rev-label">Merchant Code</span><span class="rev-value mono" style="font-size:12px">' + (m.merchantCode || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Category</span><span class="rev-value">' + (m.category || '—') + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">KYC Status</span><span class="rev-value">' + statusBadge(m.kycStatus) + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">KYC Tier</span><span class="rev-value">' + (m.kycTier ? 'Tier ' + m.kycTier : '—') + '</span></div>' +
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
      '<div class="flex" style="gap:8px">' +
        (m.isActive
          ? '<button class="btn btn-outline" style="color:var(--red);border-color:var(--red)" onclick="document.getElementById(\'modal\').style.display=\'none\';suspendMerchant(\'' + id + '\',\'' + (m.businessName||'').replace(/'/g,'') + '\')">Suspend</button>'
          : '<button class="btn btn-outline" style="color:var(--green);border-color:var(--green)" onclick="document.getElementById(\'modal\').style.display=\'none\';activateMerchant(\'' + id + '\',\'' + (m.businessName||'').replace(/'/g,'') + '\')">Activate</button>') +
        '<button class="btn btn-lime" onclick="document.getElementById(\'modal\').style.display=\'none\';editMerchant(\'' + id + '\')">&#9998; Edit</button>' +
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

// ── MERCHANT RATE CONFIG ──────────────────────────────────────────────────────

async function loadMerchantRates(id) {
  var isSA = (currentRole === 'superadmin');
  var res = await apiFetch('/merchants/' + id + '/rates');
  var rates = (res && Array.isArray(res.data)) ? res.data : [];
  var channels = ['CARD','BANK_TRANSFER','USSD','DIRECT_DEBIT','ALL'];

  var rows = rates.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px">No overrides — global rail rates apply</td></tr>'
    : rates.map(function(r) {
        return '<tr>' +
          '<td><span class="badge badge-gray">' + r.channel + '</span></td>' +
          '<td>' + (Number(r.rate)*100).toFixed(2) + '%</td>' +
          '<td>' + (r.flat_fee > 0 ? '₦' + (r.flat_fee/100).toLocaleString() : '—') + '</td>' +
          '<td>' + (r.cap > 0 ? '₦' + (r.cap/100).toLocaleString() : 'No cap') + '</td>' +
          '<td>' + (isSA ? '<button class="btn btn-outline btn-sm" style="color:var(--red)" onclick="deleteMerchantRate(\'' + id + '\',\'' + r.channel + '\')">Remove</button>' : '') + '</td>' +
        '</tr>';
      }).join('');

  var addForm = isSA ? `
    <div class="divider"></div>
    <div style="font-weight:600;margin-bottom:10px;font-size:13px">Set / Update Rate Override</div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
      <div>
        <label class="form-label">Channel</label>
        <select class="form-input form-select" id="rc-channel">
          ${channels.map(c => '<option>' + c + '</option>').join('')}
        </select>
      </div>
      <div>
        <label class="form-label">Rate (%)</label>
        <input class="form-input" type="number" id="rc-rate" value="1.5" step="0.01" min="0" max="20">
      </div>
      <div>
        <label class="form-label">Cap (₦, 0 = none)</label>
        <input class="form-input" type="number" id="rc-cap" value="2000" step="100" min="0">
      </div>
    </div>
    <div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div>
        <label class="form-label">Flat Fee (₦, 0 = none)</label>
        <input class="form-input" type="number" id="rc-flat" value="0" step="10" min="0">
      </div>
      <div>
        <label class="form-label">Notes</label>
        <input class="form-input" type="text" id="rc-notes" placeholder="Optional note for audit log">
      </div>
    </div>
    <button class="btn btn-lime" onclick="saveMerchantRate('${id}')">Save Rate Override</button>
  ` : '';

  var tabNav = '<div class="tab-nav"><button class="tab-btn" onclick="viewMerchant(\'' + id + '\')">Overview</button><button class="tab-btn active">Rate Config</button><button class="tab-btn" onclick="loadMerchantOutlets(\'' + id + '\')">Outlets</button></div>';

  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Rate Config</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    tabNav +
    '<table class="data-table" style="width:100%;margin-bottom:0"><thead><tr>' +
    '<th>Channel</th><th>Rate</th><th>Flat Fee</th><th>Cap</th><th></th></tr></thead><tbody>' +
    rows + '</tbody></table>' + addForm;

  document.getElementById('modal').style.display = 'flex';
}

async function saveMerchantRate(id) {
  var channel  = document.getElementById('rc-channel').value;
  var rateVal  = parseFloat(document.getElementById('rc-rate').value) / 100;
  var capNaira = parseFloat(document.getElementById('rc-cap').value) || 0;
  var flatNaira = parseFloat(document.getElementById('rc-flat').value) || 0;
  var notes    = document.getElementById('rc-notes').value;

  var res = await apiFetch('/merchants/' + id + '/rates', {
    method: 'POST',
    body: JSON.stringify({ channel, rate: rateVal, cap: Math.round(capNaira * 100), flat_fee: Math.round(flatNaira * 100), notes }),
  });
  if (res && res.status) {
    loadMerchantRates(id);
  } else {
    alert('Error: ' + ((res && res.message) || 'Save failed'));
  }
}

async function deleteMerchantRate(id, channel) {
  if (!confirm('Remove ' + channel + ' rate override? Merchant will fall back to global rail rates.')) return;
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

// ── MERCHANT EDIT (role-aware) ────────────────────────────────────────────────
async function editMerchant(id) {
  var isSuperAdmin = (currentRole === 'superadmin');
  var results = await Promise.all([
    apiFetch('/merchants/' + id),
    isSuperAdmin ? apiFetch('/aggregators') : Promise.resolve(null),
  ]);
  var mRes = results[0]; var aggRes = results[1];
  if (!mRes || !mRes.data) { alert('Could not load merchant'); return; }
  var m    = mRes.data;
  var aggs = (aggRes && aggRes.data) ? aggRes.data : [];

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
      '<div style="font-size:12px;font-weight:600;color:var(--gray-600);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px">Fee Configuration</div>' +
      '<div class="form-group"><label class="form-label">Fee Paid By</label>' +
        '<div class="flex" style="gap:12px;margin-top:4px">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">' +
            '<input type="radio" name="em-fee-payer" id="em-fp-customer" value="customer" ' + ((m.feePaidBy || m.fee_paid_by || 'customer') === 'customer' ? 'checked' : '') + '> Customer pays fee (default)</label>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">' +
            '<input type="radio" name="em-fee-payer" id="em-fp-merchant" value="merchant" ' + ((m.feePaidBy || m.fee_paid_by) === 'merchant' ? 'checked' : '') + '> Merchant pays fee</label>' +
        '</div>' +
        '<div class="form-hint">Customer pays: customer is debited principal + fee + VAT. Merchant pays: customer debited principal only, merchant settles net of fee.</div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:500;color:var(--gray-600);margin-bottom:8px">Per-Channel Processing Rates (%)</div>' +
      (function() {
        var rates = m.channelRates || m.channel_rates || {};
        var defaultRate = m.processingRate ? (Number(m.processingRate)*100).toFixed(2) : '1.50';
        var channels = [['CARD','Card (Visa/Mastercard/Verve)'],['BANK_TRANSFER','Bank Transfer / VA'],['USSD','USSD'],['POS','POS']];
        return '<div class="form-grid">' + channels.map(function(ch) {
          var val = rates[ch[0]] !== undefined ? (Number(rates[ch[0]])*100).toFixed(2) : defaultRate;
          return '<div class="form-group"><label class="form-label" style="font-size:11px">' + ch[1] + '</label>' +
            '<div style="display:flex;align-items:center;gap:4px">' +
            '<input class="form-input" id="em-rate-' + ch[0] + '" type="number" value="' + val + '" step="0.01" min="0" max="10" style="width:90px">' +
            '<span style="font-size:12px;color:var(--gray-400)">%</span></div></div>';
        }).join('') + '</div>';
      })() +
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
  // Collect per-channel rates
  var channelRates = {};
  ['CARD','BANK_TRANSFER','USSD','POS'].forEach(function(ch) {
    var el = document.getElementById('em-rate-' + ch);
    if (el && el.value) channelRates[ch] = parseFloat(el.value) / 100;
  });
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
  if (Object.keys(channelRates).length) body.channelRates = channelRates;
  if (feePayer) body.feePaidBy = feePayer.value;
  // Super-admin-only fields (elements won't exist in aggregator modal)
  if (document.getElementById('em-rate'))   body.processingRate = parseFloat(_val('em-rate')) / 100;
  if (document.getElementById('em-status')) body.kycStatus      = _val('em-status');
  if (document.getElementById('em-agg'))    body.aggregatorId   = _val('em-agg') || null;

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
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="editSplit('${a.id}','${a.revenueSplitPct}')">Edit Split</button>
          <button class="btn btn-outline btn-sm" onclick="viewAggRates('${a.id}','${a.companyName}')">Rate Config</button>
          <button class="btn btn-outline btn-sm" onclick="viewAggMerchants('${a.id}')">View Merchants</button>
        </div>
      </div>`).join('')}
    </div>`;
  } catch(e) {
    el.innerHTML = errorBox('Failed to load aggregators: ' + e.message);
  }
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
            <thead><tr><th>Merchant</th><th>Category</th><th>Tier</th><th>Aggregator</th><th>Addr Check</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>
              ${submissions.length ? submissions.map(s => {
                const addrStatus = s.addr_check_status || 'pending';
                const addrBadge  = addrStatus === 'passed'  ? '<span class="badge badge-green">&#10003; Verified</span>' :
                                   addrStatus === 'failed'  ? '<span class="badge badge-red">&#10007; Failed</span>' :
                                                              '<span class="badge badge-amber">Pending</span>';
                return `<tr>
                <td><div style="font-weight:500">${s.merchant.name}</div><div style="font-size:11px;color:var(--gray-400)">${s.merchant.code}</div></td>
                <td>${s.merchant.category}</td>
                <td><span class="badge badge-blue">Tier ${s.tier_applied}</span></td>
                <td>${s.merchant.aggregator||'Direct'}</td>
                <td>${addrBadge}</td>
                <td style="font-size:12px">${new Date(s.submitted_at).toLocaleDateString('en-NG')}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-outline btn-sm" onclick="showAddrVerification('${s.id}','${addrStatus}','${s.addr_report_url||''}')">&#128205; Addr</button>
                  <button class="btn btn-lime btn-sm" onclick="approveKyc('${s.id}')">Approve</button>
                  <button class="btn btn-outline btn-sm" onclick="rejectKyc('${s.id}')">Reject</button>
                </td>
              </tr>`;}).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px">No pending KYC submissions</td></tr>'}
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
      '<div class="card"><div class="table-wrap"><table>' +
        '<thead><tr><th>Ref</th><th>Merchant</th><th>Period</th><th>Txns</th><th>Fee Revenue</th><th>Rail Cost</th><th>Agg Share</th><th>Paylode Margin</th><th>Due to Merchant</th><th>Paid</th><th>Outstanding</th><th>Status</th><th>Action</th></tr></thead>' +
        '<tbody>' +
        (settlements.length ? settlements.map(function(s) {
          var outstanding = (s.outstanding || s.net_naira || 0);
          var markPaid = (s.status !== 'SETTLED')
            ? '<button class="btn btn-lime btn-sm" onclick="markSettlementPaid(\'' + s.id + '\',\'' + (s.merchant && s.merchant.businessName ? s.merchant.businessName.replace(/'/g,'') : '') + '\',' + (s.net_naira||0) + ')">Mark Paid</button>'
            : '<span style="color:var(--green);font-size:12px">&#10003; Paid</span>';
          return '<tr>' +
            '<td class="mono" style="font-size:10px">' + (s.settlementRef||'—') + '</td>' +
            '<td style="font-weight:500;font-size:12px">' + (s.merchant && s.merchant.businessName ? s.merchant.businessName : '—') + '</td>' +
            '<td style="font-size:11px">' + (s.periodStart ? s.periodStart.slice(0,10) : '—') + '</td>' +
            '<td style="text-align:center">' + (s.txnCount||0) + '</td>' +
            '<td class="mono text-lime" style="font-size:12px">₦' + ((s.fee_revenue||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono text-red" style="font-size:12px">₦' + ((s.rail_cost||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono" style="font-size:12px;color:var(--purple)">₦' + ((s.agg_share||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono" style="font-size:12px;font-weight:600">₦' + ((s.paylode_margin||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono" style="font-size:12px;font-weight:700">₦' + ((s.net_naira||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono" style="font-size:12px;color:var(--green)">₦' + ((s.amount_paid||0)).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td class="mono" style="font-size:12px;color:' + (outstanding > 0 ? 'var(--red)' : 'var(--green)') + '">₦' + outstanding.toLocaleString(undefined,{minimumFractionDigits:2}) + '</td>' +
            '<td>' + statusBadge((s.status||'pending').toLowerCase()) + '</td>' +
            '<td>' + markPaid + '</td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="13" style="text-align:center;color:var(--gray-400);padding:24px">No settlement records yet — run a batch to generate</td></tr>') +
        '</tbody>' +
      '</table></div></div>';
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
  if (!confirm('Run settlement batch for yesterday? This will create settlement records for all active merchants.')) return;
  const res = await apiFetch('/settlements/process', { method: 'POST' });
  if (res?.status) {
    alert(`Settlement complete: ${res.data.processed} batches created`);
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

async function runSandboxSettlement() {
  var today = new Date().toISOString().split('T')[0];
  if (!confirm('Run sandbox settlement batch for ' + today + '?\nThis processes isSandbox=true transactions only.')) return;
  var res = await apiFetch('/settlements/process', {
    method: 'POST',
    body:   JSON.stringify({ sandbox: true, date: today }),
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
      rejected:        'badge-red',
    };
    var statusLabels = {
      unverified:      'Not Submitted',
      pending_manual:  'Awaiting Review',
      auto_verified:   'Auto Verified',
      manual_approved: 'Approved',
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
          return '<tr>' +
            '<td><div style="font-weight:500;font-size:13px">' + m.businessName + '</div>' +
              '<div class="mono" style="font-size:10px;color:var(--gray-400)">' + (m.merchantCode||'') + '</div></td>' +
            '<td style="font-size:13px">' + (m.settlementAccountName||'<span style="color:var(--gray-400)">—</span>') + '</td>' +
            '<td style="font-size:12px">' + (m.settlementBank||'—') + '</td>' +
            '<td class="mono" style="font-size:12px">' + (m.settlementAccount||'—') + '</td>' +
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
async function loadMerchProfile() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/merchants/me');
    var m = (res && res.data) ? res.data : null;
    if (!m) {
      // fall back to user object from localStorage
      var u = getUser();
      m = { businessName: u.businessName || u.firstName || '—', category: u.category || '—',
            rcNumber: u.rcNumber || '—', phone: u.phone || '—', address: u.address || '—',
            settlementBank: u.settlementBank || '—', kycStatus: u.kycStatus || '—',
            kycTier: u.kycTier || '—', processingRate: u.processingRate || null,
            user: { email: u.email || '—' } };
    }
    var rate = m.processingRate ? (Number(m.processingRate)*100).toFixed(1)+'%' : '—';
    var rows = function(pairs) {
      return pairs.map(function(r) {
        return '<div class="rev-row"><span class="rev-label">' + r[0] + '</span><span class="rev-value" style="font-size:13px">' + r[1] + '</span></div>';
      }).join('');
    };
    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">Business Profile</div>' +
        '<div class="page-desc">Your merchant account details</div></div>' +
        '<button class="btn btn-outline btn-sm" onclick="editMerchant(\'' + (m.id||'') + '\')">&#9998; Request Edit</button>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="card"><div class="card-header"><div class="card-title">Business Information</div></div>' +
          rows([
            ['Business Name',   m.businessName || '—'],
            ['Category',        m.category || '—'],
            ['RC Number',       m.rcNumber || '—'],
            ['Email',           (m.user && m.user.email) || '—'],
            ['Phone',           m.phone || '—'],
            ['Address',         m.address || '—'],
            ['Processing Rate', rate],
            ['KYC Tier',        m.kycTier ? 'Tier ' + m.kycTier : '—'],
            ['KYC Status',      statusBadge(m.kycStatus)],
          ]) +
        '</div>' +
        '<div class="card"><div class="card-header"><div class="card-title">Settlement Account</div></div>' +
          (function() {
            var vst = m.settleVerifyStatus || 'unverified';
            var vstColors = { unverified:'badge-gray', pending_manual:'badge-amber', auto_verified:'badge-green', manual_approved:'badge-green', rejected:'badge-red' };
            var vstLabels = { unverified:'Not Submitted', pending_manual:'Awaiting Review', auto_verified:'Verified', manual_approved:'Verified', rejected:'Rejected — Update Required' };
            var vstBadge  = '<span class="badge ' + (vstColors[vst]||'badge-gray') + '">' + (vstLabels[vst]||vst) + '</span>';
            return rows([
              ['Settlement Bank',    m.settlementBank || '—'],
              ['Account Number',     m.settlementAccount ? '<span class="mono">' + m.settlementAccount + '</span>' : '—'],
              ['Account Name',       m.settlementAccountName || '—'],
              ['Verification',       vstBadge],
              ['Settlement Cycle',   m.settlementCycle || 'T+1'],
              ['Aggregator',         (m.aggregator && m.aggregator.companyName) || 'Direct'],
            ]);
          })() +
          (m.settleVerifyStatus === 'rejected' ? '<div class="warn-box" style="margin-top:12px;font-size:12px"><strong>Account rejected:</strong> ' + (m.settleVerifyNotes||'Contact support for details.') + '</div>' : '') +
          '<div class="info-box" style="margin-top:12px;font-size:12px">To update settlement account details, contact <strong>support@paylodeservices.com</strong> or use the Edit button.</div>' +
        '</div>' +
      '</div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load profile: ' + e.message);
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
    var html = keys.length ? keys.map(function(k) {
      var env = k.environment === 'live' ? 'badge-green' : 'badge-blue';
      return '<div class="rev-row"><div>' +
        '<div class="flex" style="gap:8px;margin-bottom:4px">' +
          '<span style="font-weight:600;font-size:13px">' + k.name + '</span>' +
          '<span class="badge ' + env + '">' + (k.environment||'test') + '</span>' +
        '</div>' +
        '<div class="mono" style="font-size:12px;color:var(--gray-500)">' + (k.key||'••••••••••••••••') + '</div>' +
      '</div>' +
      '<div class="flex" style="gap:6px"><button class="btn btn-outline btn-sm">Copy</button></div></div>';
    }).join('') : '<div class="info-box" style="font-size:12px">No API keys yet. Contact support to get your keys activated after KYC approval.</div>';

    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">API Keys</div></div></div>' +
      '<div class="warn-box" style="margin-bottom:20px">&#9888; Never expose your Secret Key in client-side code or version control.</div>' +
      '<div class="card">' + html + '</div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load API keys: ' + e.message);
  }
}

// ── MERCHANT WEBHOOKS ─────────────────────────────────────────────────────────
async function loadMerchWebhooks() {
  var el = document.getElementById('main-content');
  if (!el) return;
  el.innerHTML = loading();
  try {
    var res = await apiFetch('/merchants/me/webhooks');
    var hooks = (res && res.data) ? res.data : [];
    var rows = hooks.length ? hooks.map(function(h) {
      return '<div class="rev-row"><div>' +
        '<div style="font-weight:600;font-size:13px">' + (h.url||'—') + '</div>' +
        '<div style="font-size:11px;color:var(--gray-400)">Events: ' + (h.events||[]).join(' &middot; ') + '</div>' +
      '</div>' +
      '<div class="flex" style="gap:6px">' + statusBadge(h.status||'active') + '</div></div>';
    }).join('') : '<div style="color:var(--gray-400);padding:16px;text-align:center;font-size:13px">No webhooks configured yet.</div>';

    el.innerHTML =
      '<div class="page-header flex-between"><div><div class="page-title">Webhooks</div></div>' +
        '<button class="btn btn-lime btn-sm" onclick="alert(\'Contact support to add webhook endpoints.\')">+ Add Endpoint</button>' +
      '</div>' +
      '<div class="card"><div class="card-header"><div class="card-title">Active Webhooks</div></div>' + rows + '</div>';
  } catch(e) {
    el.innerHTML = errorBox('Failed to load webhooks: ' + e.message);
  }
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

// ── NAVIGATE FUNCTION ─────────────────────────────────────────────────────────
// Use window assignment (not function declaration) to avoid hoisting conflicts
window.navigate = function(page) {
  currentPage = page;
  renderNav();
  renderPage();
  loadPageData(page);
  closeSidebar();
};

function toggleUserMenu(e) {
  e.stopPropagation();
  var m = document.getElementById('user-menu');
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', function() {
  var m = document.getElementById('user-menu');
  if (m) m.style.display = 'none';
});

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
    case 'merch_overview':      loadMerchantOverview(); break;
    case 'merch_transactions':  loadTransactions(); break;
    case 'merch_settlements':   loadSettlements(); break;
    case 'merch_apikeys':       loadMerchApiKeys(); break;
    case 'merch_webhooks':      loadMerchWebhooks(); break;
    case 'merch_profile':       loadMerchProfile(); break;
    case 'agg_transactions':    loadTransactions(); break;
    case 'agg_revenue':         loadRevenueReport(); break;
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

// ── LOAD USER INFO IN TOPBAR ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var user = getUser();
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
  if      (role === 'SUPER_ADMIN' || role === 'COMPLIANCE_OFFICER') currentRole = 'superadmin';
  else if (role === 'ADMIN')       currentRole = 'admin';
  else if (role === 'AGGREGATOR')  currentRole = 'aggregator';
  else if (role === 'MERCHANT')    currentRole = 'merchant';

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
  currentPage = currentRole === 'merchant'   ? 'merch_overview' :
                currentRole === 'aggregator'  ? 'agg_overview'   : 'overview';

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
  var el   = document.getElementById('main-content');
  var user = getUser();
  var aggId   = encodeURIComponent((user && (user.id || user.merchantId)) || 'staff');
  var formUrl = '/onboarding.html?type=merchant&ref=' + aggId + '&via=staff';

  el.innerHTML =
    '<div class="page-header">' +
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
  switch(page) {
    case 'agg_onboard':          loadAggOnboard(); break;
    case 'admin_onboard':        loadAdminOnboard(); break;
    case 'payouts':              loadPayouts(); break;
    case 'rails':                loadRails(); break;
    case 'wallets':              loadWallets(); break;
    case 'product_revenue':      loadProductRevenue(); break;
    case 'users':                loadUserManagement(); break;
    case 'settle_verification':  loadSettlementQueue(); break;
    case 'email_tpl':            loadEmailTemplates(); break;
    // Static pages — _origRenderPage already rendered them, do not overwrite
    case 'settings':
    case 'sdk_start':
    case 'sdk_payments':
    case 'sdk_verify':
    case 'sdk_webhook':
    case 'sdk_mobile':
    case 'sdk_errors':
    case 'sdk_test':
      break;
    default: _origLoadPageData(page);
  }
};

(function initRole() {
  var token = localStorage.getItem('paylode_token');
  if (!token) { window.location.href = '/login.html'; return; }
  try {
    var user = JSON.parse(localStorage.getItem('paylode_user') || '{}');
    var _r = (user.role || '').toUpperCase();
    if      (_r === 'SUPER_ADMIN' || _r === 'COMPLIANCE_OFFICER') currentRole = 'superadmin';
    else if (_r === 'ADMIN')      currentRole = 'admin';
    else if (_r === 'AGGREGATOR') currentRole = 'aggregator';
    else if (_r === 'MERCHANT')   currentRole = 'merchant';
    // Super admins may use ?role= to preview other role views for testing
    if (currentRole === 'superadmin') {
      var urlRole = new URLSearchParams(window.location.search).get('role');
      if (urlRole === 'aggregator') currentRole = 'aggregator';
      if (urlRole === 'admin')      currentRole = 'admin';
      if (urlRole === 'merchant')   currentRole = 'merchant';
    }
  } catch(e) {}
})();
