// ────────────────────────────────────────────────
// PAYLODE GATEWAY — app.js  (syntax-safe rewrite)
// ────────────────────────────────────────────────

var currentRole = 'superadmin';
var currentPage = 'overview';

var RAIL_COSTS = {
  'Interswitch':    { transfer: 0.005, card: 0.015, ussd: 0.008 },
  'NIBSS':          { transfer: 0.003, card: 0.0,   ussd: 0.006 },
  'Flutterwave':    { transfer: 0.007, card: 0.018, ussd: 0.0   },
  'Paystack':       { transfer: 0.006, card: 0.015, ussd: 0.0   },
  'GT Bank Direct': { transfer: 0.004, card: 0.012, ussd: 0.007 },
};

var MERCHANTS = [
  { id:'MCH001', name:'Shoprite Nigeria',  category:'Retail',     status:'active',    aggregator:'AGG001', rate:1.5, vol:48200000,  txns:3840,  joined:'2024-01-12' },
  { id:'MCH002', name:'Bolt Nigeria',      category:'Transport',  status:'active',    aggregator:'AGG001', rate:1.2, vol:91000000,  txns:12400, joined:'2024-02-08' },
  { id:'MCH003', name:'Jumia Foods',       category:'E-commerce', status:'active',    aggregator:'AGG002', rate:1.8, vol:32100000,  txns:6200,  joined:'2024-03-01' },
  { id:'MCH004', name:'TechHub Lagos',     category:'Tech',       status:'pending',   aggregator:null,     rate:1.5, vol:0,         txns:0,     joined:'2025-05-20' },
  { id:'MCH005', name:'EduPay School',     category:'Education',  status:'active',    aggregator:'AGG002', rate:1.0, vol:18900000,  txns:1120,  joined:'2024-04-15' },
  { id:'MCH006', name:'Medplus Pharmacy',  category:'Healthcare', status:'suspended', aggregator:null,     rate:1.5, vol:4500000,   txns:340,   joined:'2024-05-10' },
];

var AGGREGATORS = [
  { id:'AGG001', name:'FinConnect Nigeria',  owner:'Adewale Okafor', merchants:2, status:'active', split:30, total_vol:139200000, joined:'2023-11-01' },
  { id:'AGG002', name:'PayBridge Solutions', owner:'Chioma Eze',     merchants:2, status:'active', split:25, total_vol:51000000,  joined:'2024-01-05' },
];

var TRANSACTIONS = [
  { ref:'TXN-20250526-001', merchant:'Bolt Nigeria',     amount:4500,  channel:'Card',     rail:'Interswitch',   status:'success', fee:54,  time:'14:32:01' },
  { ref:'TXN-20250526-002', merchant:'Shoprite Nigeria', amount:12800, channel:'Transfer', rail:'NIBSS',         status:'success', fee:192, time:'14:31:44' },
  { ref:'TXN-20250526-003', merchant:'Jumia Foods',      amount:3200,  channel:'USSD',     rail:'GT Bank Direct',status:'failed',  fee:0,   time:'14:30:22' },
  { ref:'TXN-20250526-004', merchant:'Bolt Nigeria',     amount:7600,  channel:'Card',     rail:'Interswitch',   status:'success', fee:91,  time:'14:29:18' },
  { ref:'TXN-20250526-005', merchant:'EduPay School',    amount:25000, channel:'Transfer', rail:'NIBSS',         status:'success', fee:250, time:'14:28:55' },
  { ref:'TXN-20250526-006', merchant:'Shoprite Nigeria', amount:6100,  channel:'Card',     rail:'Paystack',      status:'pending', fee:0,   time:'14:27:31' },
];

var NAV = {
  superadmin: [
    { section:'Overview',       items:[{id:'overview',icon:'◉',label:'Dashboard'},{id:'transactions',icon:'↕',label:'All Transactions'}]},
    { section:'Management',     items:[{id:'merchants',icon:'▦',label:'Merchants'},{id:'aggregators',icon:'⬡',label:'Aggregators'},{id:'revenue',icon:'₦',label:'Revenue Config'}]},
    { section:'Infrastructure', items:[{id:'rails',icon:'⊞',label:'Rail Costs'},{id:'settlement',icon:'✓',label:'Settlement'},{id:'compliance',icon:'⚖',label:'Compliance'}]},
    { section:'System',         items:[{id:'settings',icon:'⚙',label:'Settings'}]},
  ],
  aggregator: [
    { section:'Overview', items:[{id:'agg_overview',icon:'◉',label:'Dashboard'},{id:'agg_merchants',icon:'▦',label:'My Merchants'},{id:'agg_onboard',icon:'+',label:'Onboard Merchant'}]},
    { section:'Finance',  items:[{id:'agg_revenue',icon:'₦',label:'Revenue Share'},{id:'agg_transactions',icon:'↕',label:'Transactions'}]},
  ],
  merchant: [
    { section:'Overview',    items:[{id:'merch_overview',icon:'◉',label:'Dashboard'},{id:'merch_transactions',icon:'↕',label:'Transactions'},{id:'merch_settlements',icon:'✓',label:'Settlements'}]},
    { section:'Integration', items:[{id:'merch_apikeys',icon:'⚿',label:'API Keys'},{id:'merch_webhooks',icon:'⇀',label:'Webhooks'}]},
    { section:'Account',     items:[{id:'merch_profile',icon:'⊙',label:'Business Profile'}]},
  ],
  developer: [
    { section:'SDK',       items:[{id:'sdk_start',icon:'▶',label:'Quick Start'},{id:'sdk_payments',icon:'₦',label:'Payments API'},{id:'sdk_verify',icon:'✓',label:'Verify Payment'},{id:'sdk_webhook',icon:'⇀',label:'Webhooks'},{id:'sdk_mobile',icon:'□',label:'Mobile SDKs'}]},
    { section:'Reference', items:[{id:'sdk_errors',icon:'!',label:'Error Codes'},{id:'sdk_test',icon:'⚡',label:'Test Cards'}]},
  ],
};

var ROLE_META = {
  superadmin: { label:'Super Admin', name:'Paylode HQ',         title:'Super Admin Dashboard', defaultPage:'overview'       },
  aggregator:  { label:'Aggregator',  name:'FinConnect Nigeria', title:'Aggregator Dashboard',  defaultPage:'agg_overview'   },
  merchant:    { label:'Merchant',    name:'Bolt Nigeria',       title:'Merchant Dashboard',    defaultPage:'merch_overview' },
  developer:   { label:'Developer',   name:'API / SDK Docs',     title:'Developer SDK',         defaultPage:'sdk_start'      },
};

function renderNav() {
  var meta = ROLE_META[currentRole];
  document.getElementById('role-label').textContent    = meta.label;
  document.getElementById('role-name').textContent     = meta.name;
  document.getElementById('topbar-title').textContent  = meta.title;
  var container = document.getElementById('nav-items');
  container.innerHTML = NAV[currentRole].map(function(sec) {
    var itemsHtml = sec.items.map(function(item) {
      return '<div class="nav-item ' + (item.id === currentPage ? 'active' : '') + '" onclick="navigate(\'' + item.id + '\')">' +
             '<span class="nav-icon">' + item.icon + '</span>' + item.label + '</div>';
    }).join('');
    return '<div class="nav-section"><div class="nav-section-label">' + sec.section + '</div>' + itemsHtml + '</div>';
  }).join('');
  document.querySelectorAll('.role-btn').forEach(function(btn, i) {
    btn.classList.toggle('active', ['superadmin','aggregator','merchant','developer'][i] === currentRole);
  });
}

function switchRole(role) { currentRole = role; currentPage = ROLE_META[role].defaultPage; renderNav(); renderPage(); }
function navigate(page)   { currentPage = page; renderNav(); renderPage(); }

function statusBadge(s) {
  var m = {active:'badge-green',success:'badge-green',completed:'badge-green',pending:'badge-amber',failed:'badge-red',suspended:'badge-red'};
  return '<span class="badge ' + (m[s] || 'badge-gray') + '">' + s + '</span>';
}
function showModal(html) { document.getElementById('modal-inner').innerHTML = html; document.getElementById('modal').style.display = 'flex'; }
function closeModal(e)   { if (e.target.id === 'modal') document.getElementById('modal').style.display = 'none'; }
function sdkTabState()   { return window.__sdkTab || 'js'; }
function setSdkTab(t)    { window.__sdkTab = t; renderPage(); }

function renderPage() {
  var pages = {
    overview:renderSuperOverview, transactions:renderTransactions,
    merchants:renderMerchants, aggregators:renderAggregators,
    revenue:renderRevenueConfig, rails:renderRailCosts,
    settlement:renderSettlement, compliance:renderCompliance, settings:renderSettings,
    agg_overview:renderAggOverview, agg_merchants:renderAggMerchants,
    agg_onboard:renderAggOnboard, agg_revenue:renderAggRevenue,
    agg_transactions:renderAggTransactions,
    merch_overview:renderMerchOverview, merch_transactions:renderMerchTransactions,
    merch_settlements:renderMerchSettlements, merch_apikeys:renderMerchApiKeys,
    merch_webhooks:renderMerchWebhooks, merch_profile:renderMerchProfile,
    sdk_start:renderSdkStart, sdk_payments:renderSdkPayments,
    sdk_verify:renderSdkVerify, sdk_webhook:renderSdkWebhookDocs,
    sdk_mobile:renderSdkMobile, sdk_errors:renderSdkErrors, sdk_test:renderSdkTestCards,
  };
  document.getElementById('main-content').innerHTML = (pages[currentPage] || renderSuperOverview)();
}

function renderSuperOverview() {
  var txRows = TRANSACTIONS.slice(0,4).map(function(t) {
    return '<tr><td>' + t.merchant.split(' ')[0] + '</td><td class="mono">&#8358;' + t.amount.toLocaleString() +
           '</td><td><span class="tag">' + t.channel + '</span></td><td>' + statusBadge(t.status) + '</td></tr>';
  }).join('');
  var channelData = [['Card Payments','58','var(--blue)'],['Bank Transfer','29','var(--lime)'],['USSD','13','var(--amber)']];
  var channelHtml = channelData.map(function(row) {
    return '<div style="margin-bottom:12px"><div class="flex-between" style="margin-bottom:4px">' +
           '<span style="font-size:12px;color:var(--gray-600)">' + row[0] + '</span>' +
           '<span style="font-size:12px;font-weight:600">' + row[1] + '%</span></div>' +
           '<div class="progress-bar"><div class="progress-fill" style="width:' + row[1] + '%;background:' + row[2] + '"></div></div></div>';
  }).join('');
  var railHtml = [['Interswitch','&#8358;980M','52%'],['NIBSS','&#8358;720M','38%'],['GT Bank','&#8358;180M','10%']].map(function(row) {
    return '<div class="rev-row"><span class="rev-label" style="font-size:12px">' + row[0] + '</span>' +
           '<div class="flex" style="gap:6px"><span class="rev-value" style="font-size:12px">' + row[1] + '</span>' +
           '<span class="badge badge-gray">' + row[2] + '</span></div></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Platform Overview</div>' +
    '<div class="page-desc">Real-time metrics across all merchants, aggregators, and payment rails</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--lime)"></span>Total Volume (MTD)</div><div class="stat-value">&#8358;3.18B</div><div class="stat-sub"><span class="stat-change up">&#8593; 18.4%</span> vs last month</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--blue)"></span>Gross Revenue</div><div class="stat-value">&#8358;47.8M</div><div class="stat-sub"><span class="stat-change up">&#8593; 12.1%</span> vs last month</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--purple)"></span>Active Merchants</div><div class="stat-value">42</div><div class="stat-sub">3 pending approval</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--amber)"></span>Aggregators</div><div class="stat-value">8</div><div class="stat-sub">2 onboarding</div></div>' +
    '</div><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div><div class="card-title">Revenue Breakdown (Today)</div><div class="card-subtitle">Gross &#8594; Rail Cost &#8594; Paylode Margin &#8594; Partner Share</div></div></div>' +
    '<div class="rev-row"><span class="rev-label">Gross Collections</span><span class="rev-value">&#8358;1,842,400</span></div>' +
    '<div class="rev-row"><span class="rev-label">Rail Costs (avg 0.8%)</span><span class="rev-value text-red">&#8722; &#8358;148,680</span></div>' +
    '<div class="rev-row"><span class="rev-label">Net After Rails</span><span class="rev-value">&#8358;1,693,720</span></div>' +
    '<div class="rev-row"><span class="rev-label">Paylode Margin</span><span class="rev-value text-lime">&#8358;1,185,604</span></div>' +
    '<div class="rev-row"><span class="rev-label">Aggregator Payouts</span><span class="rev-value" style="color:var(--purple)">&#8722; &#8358;508,116</span></div>' +
    '<div class="rev-net"><span style="font-weight:700;font-size:13px;color:#166534">Net Paylode Revenue</span><span style="font-weight:800;font-size:18px;color:#166534">&#8358;677,488</span></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Recent Transactions</div><button class="btn btn-outline btn-sm" onclick="navigate(\'transactions\')">View All</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Merchant</th><th>Amount</th><th>Channel</th><th>Status</th></tr></thead><tbody>' + txRows + '</tbody></table></div></div></div>' +
    '<div class="section-gap"><div class="grid-3">' +
    '<div class="card"><div class="card-header"><div class="card-title">Channel Split</div></div>' + channelHtml + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Top Rail by Volume</div></div>' + railHtml + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Pending Actions</div></div>' +
    '<div style="display:flex;flex-direction:column;gap:8px">' +
    '<div class="warn-box" style="font-size:12px">&#9888; 3 merchant KYC documents awaiting review</div>' +
    '<div class="info-box" style="font-size:12px">&#8505; 1 new aggregator application received</div>' +
    '<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;font-size:12px;color:#166534">&#10003; Settlement batch for Tue 20-May sent</div>' +
    '</div></div></div></div>';
}

function renderTransactions() {
  var rows = TRANSACTIONS.map(function(t) {
    return '<tr><td class="mono" style="font-size:11px">' + t.ref + '</td><td>' + t.merchant + '</td>' +
           '<td class="mono">&#8358;' + t.amount.toLocaleString() + '</td><td class="mono text-lime">&#8358;' + t.fee + '</td>' +
           '<td><span class="tag">' + t.channel + '</span></td><td><span class="tag">' + t.rail + '</span></td>' +
           '<td>' + statusBadge(t.status) + '</td><td style="color:var(--gray-400);font-size:12px">' + t.time + '</td></tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">All Transactions</div>' +
    '<div class="page-desc">Live transaction feed across all merchants and rails</div></div>' +
    '<button class="btn btn-outline btn-sm">&#8681; Export CSV</button></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--green)"></span>Successful</div><div class="stat-value">23,481</div><div class="stat-sub">&#8358;2.8B volume</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--red)"></span>Failed</div><div class="stat-value">342</div><div class="stat-sub">1.4% failure rate</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--amber)"></span>Pending</div><div class="stat-value">18</div><div class="stat-sub">Awaiting confirmation</div></div>' +
    '<div class="stat-card"><div class="stat-label"><span class="dot" style="background:var(--purple)"></span>Reversed</div><div class="stat-value">29</div><div class="stat-sub">&#8358;3.4M reversed</div></div></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Fee</th><th>Channel</th><th>Rail</th><th>Status</th><th>Time</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderMerchants() {
  var rows = MERCHANTS.map(function(m) {
    var aggBadge = m.aggregator ? '<span class="badge badge-purple">' + m.aggregator + '</span>' : '<span class="badge badge-gray">Direct</span>';
    return '<tr><td class="mono" style="font-size:11px">' + m.id + '</td><td><strong>' + m.name + '</strong></td>' +
           '<td><span class="tag">' + m.category + '</span></td><td>' + aggBadge + '</td>' +
           '<td><span class="badge badge-lime">' + m.rate + '%</span></td>' +
           '<td class="mono">&#8358;' + (m.vol/1000000).toFixed(1) + 'M</td>' +
           '<td>' + statusBadge(m.status) + '</td>' +
           '<td><button class="btn btn-outline btn-sm" onclick="showMerchantRateModal(\'' + m.id + '\')">&#9881; Rate</button></td></tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">Merchant Management</div>' +
    '<div class="page-desc">Manage all merchants, rates, and account status</div></div>' +
    '<button class="btn btn-lime" onclick="showAddMerchantModal()">+ Add Merchant</button></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>ID</th><th>Merchant</th><th>Category</th><th>Aggregator</th><th>Rate</th><th>Vol (MTD)</th><th>Status</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderAggregators() {
  var cards = AGGREGATORS.map(function(a) {
    return '<div class="card" style="margin-bottom:16px">' +
      '<div class="flex-between" style="margin-bottom:16px"><div><div style="font-weight:700;font-size:15px">' + a.name + '</div>' +
      '<div style="font-size:12px;color:var(--gray-400)">Owner: ' + a.owner + ' &middot; ID: ' + a.id + ' &middot; Joined: ' + a.joined + '</div></div>' +
      '<div class="flex" style="gap:8px">' + statusBadge(a.status) + '<button class="btn btn-outline btn-sm" onclick="showEditAggModal(\'' + a.id + '\')">&#9998; Edit Split</button></div></div>' +
      '<div class="grid-3">' +
      '<div class="stat-card card-sm"><div class="stat-label">Revenue Split</div><div class="stat-value" style="font-size:20px">' + a.split + '%</div><div class="stat-sub">of net after rails</div></div>' +
      '<div class="stat-card card-sm"><div class="stat-label">Active Merchants</div><div class="stat-value" style="font-size:20px">' + a.merchants + '</div><div class="stat-sub">under this aggregator</div></div>' +
      '<div class="stat-card card-sm"><div class="stat-label">MTD Volume</div><div class="stat-value" style="font-size:20px">&#8358;' + (a.total_vol/1000000).toFixed(0) + 'M</div><div class="stat-sub">across all merchants</div></div></div>' +
      '<div class="divider"></div>' +
      '<div class="rev-row"><span class="rev-label">Estimated Gross Revenue (MTD)</span><span class="rev-value">&#8358;' + (a.total_vol*0.015/1000000).toFixed(2) + 'M</span></div>' +
      '<div class="rev-row"><span class="rev-label">Rail Cost Deduction (est. 0.8%)</span><span class="rev-value text-red">&#8722; &#8358;' + (a.total_vol*0.008/1000000).toFixed(2) + 'M</span></div>' +
      '<div class="rev-row"><span class="rev-label">Net Revenue After Rails</span><span class="rev-value">&#8358;' + (a.total_vol*0.007/1000000).toFixed(2) + 'M</span></div>' +
      '<div class="rev-net"><span style="font-weight:600;font-size:13px;color:#166534">Aggregator Payout (' + a.split + '%)</span>' +
      '<span style="font-weight:800;font-size:16px;color:#166534">&#8358;' + (a.total_vol*0.007*a.split/100/1000000).toFixed(3) + 'M</span></div></div>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">Aggregator Management</div>' +
    '<div class="page-desc">Manage aggregator partnerships and revenue sharing</div></div>' +
    '<button class="btn btn-lime" onclick="showAddAggModal()">+ Add Aggregator</button></div>' + cards;
}

function renderRevenueConfig() {
  var tierHtml = [['Standard','1.5%','Default for new merchants'],['Growth (&#8358;50M+/mo)','1.2%','Auto-applied at threshold'],
    ['Enterprise (&#8358;200M+/mo)','0.9%','Manual application required'],['Non-Profit/NGO','0.5%','Requires CBN approval letter']].map(function(row) {
    return '<div class="rev-row"><div><div style="font-size:13px;font-weight:600">' + row[0] + '</div>' +
           '<div style="font-size:11px;color:var(--gray-400)">' + row[2] + '</div></div>' +
           '<div class="flex" style="gap:8px"><span class="badge badge-lime">' + row[1] + '</span>' +
           '<button class="btn btn-outline btn-sm" style="font-size:11px">Edit</button></div></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Revenue Configuration</div>' +
    '<div class="page-desc">Set merchant processing rates, Paylode margin, and aggregator revenue sharing rules</div></div>' +
    '<div class="warn-box" style="margin-bottom:20px">&#9888; Changes to rates take effect immediately.</div>' +
    '<div class="grid-2"><div class="card"><div class="card-header"><div class="card-title">Default Merchant Rate Tiers</div></div>' + tierHtml + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Revenue Netting Formula</div></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">This formula determines how Paylode calculates what to share with aggregators after rail costs.</div>' +
    '<div class="code-block"><span class="kw">merchant_fee</span> = txn_amount &times; merchant_rate<br><span class="kw">rail_cost</span> = txn_amount &times; rail_rate[channel]<br>' +
    '<span class="kw">net_revenue</span> = merchant_fee &minus; rail_cost<br><span class="fn">agg_share</span> = net_revenue &times; agg_split_pct<br>' +
    '<span class="str">paylode_margin</span> = net_revenue &minus; agg_share</div>' +
    '<div class="divider"></div>' +
    '<div class="form-group"><label class="form-label">Default Aggregator Split (%)</label>' +
    '<input class="form-input" type="number" value="30" min="1" max="70" style="width:120px">' +
    '<div class="form-hint">Overridden per aggregator in Aggregator Management</div></div>' +
    '<button class="btn btn-primary btn-sm">Save Default Config</button></div></div>';
}

function renderRailCosts() {
  var rows = Object.keys(RAIL_COSTS).map(function(rail) {
    var c = RAIL_COSTS[rail];
    return '<tr><td><strong>' + rail + '</strong></td>' +
           '<td class="mono">' + (c.transfer ? (c.transfer*100).toFixed(2)+'%' : '&mdash;') + '</td>' +
           '<td class="mono">' + (c.card     ? (c.card*100).toFixed(2)+'%'     : '&mdash;') + '</td>' +
           '<td class="mono">' + (c.ussd     ? (c.ussd*100).toFixed(2)+'%'     : '&mdash;') + '</td>' +
           '<td style="font-size:12px;color:var(--gray-400)">2025-05-01</td>' +
           '<td><button class="btn btn-outline btn-sm" onclick="showEditRailModal(\'' + rail + '\')">&#9998; Edit</button></td></tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">Payment Rail Cost Configuration</div>' +
    '<div class="page-desc">Manually enter what each bank/payment network charges Paylode per channel</div></div>' +
    '<button class="btn btn-lime" onclick="showAddRailModal()">+ Add Rail</button></div>' +
    '<div class="info-box" style="margin-bottom:20px">These rates are used to calculate net revenue after deducting Paylode\'s cost before aggregator sharing.</div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Rail / Bank</th><th>Transfer Rate</th><th>Card Rate</th><th>USSD Rate</th><th>Last Updated</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>' +
    '<div class="warn-box" style="margin-top:16px">&#9888; <strong>Rail connection not yet live.</strong> Cost configuration only.</div>';
}

function renderSettlement() {
  var rows = MERCHANTS.filter(function(m){ return m.status==='active'; }).map(function(m) {
    return '<tr><td>' + m.name + '</td><td class="mono">&#8358;' + (m.vol/30/1000).toFixed(0) + 'K</td>' +
           '<td class="mono text-red">&#8358;' + (m.vol/30*m.rate/100/1000).toFixed(1) + 'K</td>' +
           '<td class="mono">&#8358;' + (m.vol/30*(1-m.rate/100)/1000).toFixed(0) + 'K</td>' +
           '<td><span class="tag">GTB ****4421</span></td><td><span class="badge badge-amber">Pending</span></td></tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Settlement Management</div>' +
    '<div class="page-desc">Track and manage merchant settlements and aggregator payouts</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">Pending Settlement</div><div class="stat-value">&#8358;284M</div><div class="stat-sub">14 merchant batches</div></div>' +
    '<div class="stat-card"><div class="stat-label">Settled Today</div><div class="stat-value">&#8358;91M</div><div class="stat-sub">8 batches processed</div></div>' +
    '<div class="stat-card"><div class="stat-label">Agg. Payout Due</div><div class="stat-value">&#8358;8.4M</div><div class="stat-sub">Next: 28 May 2025</div></div>' +
    '<div class="stat-card"><div class="stat-label">Float Balance</div><div class="stat-value">&#8358;1.2B</div><div class="stat-sub">CBN escrow account</div></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Settlement Queue</div><button class="btn btn-lime btn-sm">Process All Pending</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Merchant</th><th>Settlement Amt</th><th>Fees Deducted</th><th>Net to Merchant</th><th>Bank</th><th>Status</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderCompliance() {
  var licenseHtml = [['License Type','Payment Solution Service Provider (PSSP)'],['License No','CBN/PAY/2024/001847'],
    ['Issued Date','2024-03-15'],['Expiry','2027-03-14'],['Status','Active &amp; Valid']].map(function(row) {
    return '<div class="rev-row"><span class="rev-label">' + row[0] + '</span><span class="rev-value" style="font-size:12px">' + row[1] + '</span></div>';
  }).join('');
  var checkHtml = [[true,'Merchant KYC/KYB Policy Documented'],[true,'AML/CFT Policy Filed with CBN'],
    [true,'Transaction Monitoring System Active'],[false,'Quarterly CBN Return (Q1 2025)'],
    [false,'Annual Audit Submission'],[true,'Data Privacy Policy (NDPR Compliant)']].map(function(row) {
    return '<div class="flex" style="margin-bottom:10px;gap:8px">' +
           '<span style="color:' + (row[0]?'var(--green)':'var(--amber)') + ';font-weight:600">' + (row[0]?'&#10003;':'&#9675;') + '</span>' +
           '<span style="font-size:13px;color:' + (row[0]?'var(--gray-700)':'var(--amber)') + '">' + row[1] + '</span></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Compliance &amp; CBN Reporting</div>' +
    '<div class="page-desc">Regulatory compliance, AML/KYC monitoring, and CBN reporting obligations</div></div>' +
    '<div class="grid-3" style="margin-bottom:20px">' +
    '<div class="stat-card"><div class="stat-label">KYC Pending</div><div class="stat-value text-red">3</div></div>' +
    '<div class="stat-card"><div class="stat-label">AML Flags</div><div class="stat-value text-amber">1</div></div>' +
    '<div class="stat-card"><div class="stat-label">CBN Reports Due</div><div class="stat-value">2</div></div></div>' +
    '<div class="grid-2"><div class="card"><div class="card-header"><div class="card-title">CBN License Details</div></div>' + licenseHtml + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Compliance Checklist</div></div>' + checkHtml + '</div></div>';
}

function renderSettings() {
  return '<div class="page-header"><div class="page-title">Platform Settings</div></div><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Webhook Global Settings</div></div>' +
    '<div class="form-group"><label class="form-label">Webhook Signing Secret</label>' +
    '<div class="password-wrapper">' +
    '<input id="wh-secret" class="form-input mono" type="password" value="whsec_paylode_xk8m2..." style="padding-right:40px;">' +
    '<button type="button" class="toggle-password" onclick="toggleWebhookSecret()" aria-label="Toggle Secret Visibility" tabindex="-1">' +
    '<svg class="eye-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />' +
    '</svg>' +
    '<svg class="eye-slash-icon" style="display:none;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">' +
    '<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />' +
    '</svg>' +
    '</button>' +
    '</div></div>' +
    '<div class="form-group"><label class="form-label">Retry Attempts</label><input class="form-input" type="number" value="3" style="width:80px"></div>' +
    '<div class="form-group"><label class="form-label">Retry Interval (seconds)</label><input class="form-input" type="number" value="30" style="width:80px"></div>' +
    '<button class="btn btn-primary btn-sm">Save Webhook Config</button></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Transaction Limits</div></div>' +
    '<div class="form-group"><label class="form-label">Single Transaction Cap (&#8358;)</label><input class="form-input" value="5,000,000"></div>' +
    '<div class="form-group"><label class="form-label">Daily Merchant Limit Default (&#8358;)</label><input class="form-input" value="50,000,000"></div>' +
    '<div class="form-group"><label class="form-label">USSD Transaction Limit (&#8358;)</label><input class="form-input" value="100,000"></div>' +
    '<button class="btn btn-primary btn-sm">Save Limits</button></div></div>';
}

function renderAggOverview() {
  var merch = MERCHANTS.filter(function(m){ return m.aggregator==='AGG001'; }).map(function(m) {
    return '<div class="flex-between" style="padding:10px 0;border-bottom:1px solid var(--gray-100)">' +
           '<div><div style="font-weight:600;font-size:13px">' + m.name + '</div>' +
           '<div style="font-size:11px;color:var(--gray-400)">' + m.category + ' &middot; Rate: ' + m.rate + '%</div></div>' +
           '<div class="flex" style="gap:6px">' + statusBadge(m.status) +
           '<span class="mono" style="font-size:12px">&#8358;' + (m.vol/1000000).toFixed(1) + 'M</span></div></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Aggregator Dashboard</div>' +
    '<div class="page-desc">FinConnect Nigeria &mdash; Your merchant portfolio performance</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">Active Merchants</div><div class="stat-value">2</div></div>' +
    '<div class="stat-card"><div class="stat-label">MTD Volume</div><div class="stat-value">&#8358;139M</div><div class="stat-sub"><span class="stat-change up">&#8593; 22%</span></div></div>' +
    '<div class="stat-card"><div class="stat-label">Gross Revenue</div><div class="stat-value">&#8358;1.98M</div></div>' +
    '<div class="stat-card"><div class="stat-label">Your Payout (30%)</div><div class="stat-value" style="color:var(--lime-dark)">&#8358;415K</div><div class="stat-sub">Due 28 May 2025</div></div></div>' +
    '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Revenue Share Breakdown</div></div>' +
    '<div class="rev-row"><span class="rev-label">Total Merchant Fees Collected</span><span class="rev-value">&#8358;1,984,000</span></div>' +
    '<div class="rev-row"><span class="rev-label">Paylode Rail Deduction</span><span class="rev-value text-red">&#8722; &#8358;389,760</span></div>' +
    '<div class="rev-row"><span class="rev-label">Net Revenue Pool</span><span class="rev-value">&#8358;1,594,240</span></div>' +
    '<div class="rev-net"><span style="font-weight:700;font-size:13px;color:#166534">Your Share (30%)</span><span style="font-weight:800;font-size:18px;color:#166534">&#8358;478,272</span></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">My Merchants</div>' +
    '<button class="btn btn-lime btn-sm" onclick="navigate(\'agg_onboard\')">+ Onboard New</button></div>' + merch + '</div></div>';
}

function renderAggMerchants() {
  var rows = MERCHANTS.filter(function(m){ return m.aggregator==='AGG001'; }).map(function(m) {
    return '<tr><td><strong>' + m.name + '</strong><div class="mono" style="font-size:10px;color:var(--gray-400)">' + m.id + '</div></td>' +
           '<td><span class="tag">' + m.category + '</span></td><td><span class="badge badge-lime">' + m.rate + '%</span></td>' +
           '<td class="mono">&#8358;' + (m.vol/1000000).toFixed(1) + 'M</td><td class="mono">' + m.txns.toLocaleString() + '</td>' +
           '<td>' + statusBadge(m.status) + '</td></tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">My Merchant Portfolio</div></div>' +
    '<button class="btn btn-lime" onclick="navigate(\'agg_onboard\')">+ Onboard Merchant</button></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Merchant</th><th>Category</th><th>Rate</th><th>MTD Volume</th><th>Transactions</th><th>Status</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderAggOnboard() {
  return '<div class="page-header"><div class="page-title">Onboard New Merchant</div>' +
    '<div class="page-desc">Register a new merchant under your aggregator portfolio</div></div>' +
    '<div class="card" style="max-width:600px">' +
    '<div class="info-box" style="margin-bottom:20px;font-size:12px">By signing up this merchant, you agree to be responsible for their compliance with Paylode\'s acceptable use policy.</div>' +
    '<div class="form-group"><label class="form-label">Business Name *</label><input class="form-input" placeholder="e.g. Zenith Supermarket Ltd"></div>' +
    '<div class="form-grid"><div class="form-group"><label class="form-label">Business Category *</label>' +
    '<select class="form-input form-select"><option>Retail</option><option>E-commerce</option><option>Food &amp; Beverage</option><option>Transport</option><option>Education</option><option>Healthcare</option><option>Other</option></select></div>' +
    '<div class="form-group"><label class="form-label">Expected Monthly Volume *</label>' +
    '<select class="form-input form-select"><option>Under &#8358;5M</option><option>&#8358;5M &ndash; &#8358;50M</option><option>&#8358;50M &ndash; &#8358;200M</option><option>Above &#8358;200M</option></select></div></div>' +
    '<div class="form-grid"><div class="form-group"><label class="form-label">Contact Name *</label><input class="form-input" placeholder="Full name"></div>' +
    '<div class="form-group"><label class="form-label">Contact Email *</label><input class="form-input" type="email" placeholder="ceo@business.com"></div></div>' +
    '<div class="form-grid"><div class="form-group"><label class="form-label">Phone Number</label><input class="form-input" placeholder="+234 ..."></div>' +
    '<div class="form-group"><label class="form-label">RC Number (CAC)</label><input class="form-input" placeholder="RC 123456"></div></div>' +
    '<div class="form-group"><label class="form-label">Business Address</label><input class="form-input" placeholder="Street, City, State"></div>' +
    '<div class="divider"></div>' +
    '<div class="flex-between"><button class="btn btn-outline">Save as Draft</button><button class="btn btn-lime">Submit for Approval &#8594;</button></div></div>';
}

function renderAggRevenue() {
  var tableRows = [['May 2025','&#8358;139M','&#8358;1.98M','&#8358;389K','&#8358;1.59M','&#8358;478K','pending'],
    ['Apr 2025','&#8358;114M','&#8358;1.62M','&#8358;318K','&#8358;1.30M','&#8358;391K','completed'],
    ['Mar 2025','&#8358;101M','&#8358;1.43M','&#8358;281K','&#8358;1.15M','&#8358;344K','completed']].map(function(r) {
    return '<tr>' + r.map(function(v,i){ return '<td class="' + (i>0&&i<6?'mono':'') + ' ' + (i===5?'text-lime':'') + '">' + (i===6?statusBadge(v):v) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Revenue Share Statement</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">Earned (May 2025)</div><div class="stat-value text-lime">&#8358;478K</div></div>' +
    '<div class="stat-card"><div class="stat-label">Earned (Apr 2025)</div><div class="stat-value">&#8358;391K</div></div>' +
    '<div class="stat-card"><div class="stat-label">Earned (Mar 2025)</div><div class="stat-value">&#8358;344K</div></div>' +
    '<div class="stat-card"><div class="stat-label">Total Earned (YTD)</div><div class="stat-value">&#8358;2.1M</div></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Monthly Statements</div><button class="btn btn-outline btn-sm">&#8681; Download All</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Period</th><th>Merchant Volume</th><th>Gross Revenue</th><th>Rail Deduction</th><th>Net Pool</th><th>Your Share (30%)</th><th>Status</th></tr></thead>' +
    '<tbody>' + tableRows + '</tbody></table></div></div>';
}

function renderAggTransactions() {
  var rows = TRANSACTIONS.filter(function(t){ return ['Bolt Nigeria','Shoprite Nigeria'].indexOf(t.merchant)>-1; }).map(function(t) {
    return '<tr><td class="mono" style="font-size:11px">' + t.ref + '</td><td>' + t.merchant + '</td>' +
           '<td class="mono">&#8358;' + t.amount.toLocaleString() + '</td><td class="mono text-lime">&#8358;' + (t.fee*0.3).toFixed(0) + '</td>' +
           '<td><span class="tag">' + t.channel + '</span></td><td>' + statusBadge(t.status) + '</td>' +
           '<td style="font-size:12px;color:var(--gray-400)">' + t.time + '</td></tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Portfolio Transactions</div></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Reference</th><th>Merchant</th><th>Amount</th><th>Your Fee Share</th><th>Channel</th><th>Status</th><th>Time</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderMerchOverview() {
  var txRows = TRANSACTIONS.filter(function(t){ return t.merchant==='Bolt Nigeria'; }).map(function(t) {
    return '<tr><td class="mono" style="font-size:11px">' + t.ref.slice(-8) + '</td>' +
           '<td class="mono">&#8358;' + t.amount.toLocaleString() + '</td>' +
           '<td><span class="tag">' + t.channel + '</span></td><td>' + statusBadge(t.status) + '</td></tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Merchant Dashboard</div>' +
    '<div class="page-desc">Bolt Nigeria &mdash; Payment performance overview</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">Today\'s Volume</div><div class="stat-value">&#8358;12.1M</div><div class="stat-sub"><span class="stat-change up">&#8593; 8.2%</span> vs yesterday</div></div>' +
    '<div class="stat-card"><div class="stat-label">Success Rate</div><div class="stat-value">98.6%</div></div>' +
    '<div class="stat-card"><div class="stat-label">Settled Today</div><div class="stat-value">&#8358;11.8M</div><div class="stat-sub">T+1 settlement</div></div>' +
    '<div class="stat-card"><div class="stat-label">Processing Rate</div><div class="stat-value text-lime">1.2%</div><div class="stat-sub">Growth tier rate</div></div></div>' +
    '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Recent Transactions</div>' +
    '<button class="btn btn-outline btn-sm" onclick="navigate(\'merch_transactions\')">View All</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Amount</th><th>Channel</th><th>Status</th></tr></thead>' +
    '<tbody>' + txRows + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Fee Breakdown (Today)</div></div>' +
    '<div class="rev-row"><span class="rev-label">Total Collections</span><span class="rev-value">&#8358;12,100,000</span></div>' +
    '<div class="rev-row"><span class="rev-label">Processing Fees (1.2%)</span><span class="rev-value text-red">&#8358;145,200</span></div>' +
    '<div class="rev-net"><span style="font-weight:700;font-size:13px;color:#166534">Your Net Settlement</span><span style="font-weight:800;font-size:18px;color:#166534">&#8358;11,954,800</span></div>' +
    '<div class="divider"></div><div style="font-size:12px;color:var(--gray-400)">Settlement disbursed by 9AM next business day to GTBank ****1234</div>' +
    '</div></div>';
}

function renderMerchTransactions() {
  var rows = TRANSACTIONS.filter(function(t){ return t.merchant==='Bolt Nigeria'; }).map(function(t) {
    return '<tr><td class="mono" style="font-size:11px">' + t.ref + '</td>' +
           '<td class="mono">&#8358;' + t.amount.toLocaleString() + '</td><td class="mono text-red">&#8358;' + t.fee + '</td>' +
           '<td class="mono">&#8358;' + (t.amount-t.fee).toLocaleString() + '</td>' +
           '<td><span class="tag">' + t.channel + '</span></td><td>' + statusBadge(t.status) + '</td>' +
           '<td style="font-size:12px;color:var(--gray-400)">' + t.time + '</td></tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">Transactions</div></div>' +
    '<button class="btn btn-outline btn-sm">&#8681; Export</button></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Reference</th><th>Amount</th><th>Fee</th><th>Net</th><th>Channel</th><th>Status</th><th>Time</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderMerchSettlements() {
  var rows = [['26 May 2025','25 May','&#8358;11,200,000','&#8358;134,400','&#8358;11,065,600','GTB ****1234','pending'],
    ['25 May 2025','24 May','&#8358;9,800,000','&#8358;117,600','&#8358;9,682,400','GTB ****1234','completed'],
    ['24 May 2025','23 May','&#8358;12,400,000','&#8358;148,800','&#8358;12,251,200','GTB ****1234','completed']].map(function(r) {
    return '<tr>' + r.map(function(v,i){ return '<td class="' + (i>=2&&i<=4?'mono':'') + '">' + (i===6?statusBadge(v):v) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Settlements</div></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Settlement Date</th><th>Period</th><th>Gross</th><th>Fees</th><th>Net Settled</th><th>Destination</th><th>Status</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderMerchApiKeys() {
  var html = [['Public Key (Test)','pk_test_bolt_a8f2e9c1d3b7','badge-blue','Test','Use in frontend initialization'],
    ['Secret Key (Test)','sk_test_&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;','badge-amber','Test','Server-side only &mdash; never expose'],
    ['Public Key (Live)','pk_live_bolt_x9k3m2p8q4r1','badge-green','Live','Production frontend key'],
    ['Secret Key (Live)','sk_live_&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;','badge-red','Live','Production server key &mdash; keep secret']].map(function(k) {
    return '<div class="rev-row"><div><div class="flex" style="gap:8px;margin-bottom:4px">' +
           '<span style="font-weight:600;font-size:13px">' + k[0] + '</span><span class="badge ' + k[2] + '">' + k[3] + '</span></div>' +
           '<div class="mono" style="font-size:12px;color:var(--gray-500)">' + k[1] + '</div>' +
           '<div class="form-hint">' + k[4] + '</div></div>' +
           '<div class="flex" style="gap:6px"><button class="btn btn-outline btn-sm">Copy</button><button class="btn btn-outline btn-sm">&#8635; Rotate</button></div></div>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">API Keys</div></div>' +
    '<button class="btn btn-lime">+ Generate New Key</button></div>' +
    '<div class="warn-box" style="margin-bottom:20px">&#9888; Never expose your Secret Key in client-side code or version control.</div>' +
    '<div class="card">' + html + '</div>';
}

function renderMerchWebhooks() {
  return '<div class="page-header"><div class="page-title">Webhooks</div></div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Active Webhooks</div>' +
    '<button class="btn btn-lime btn-sm">+ Add Endpoint</button></div>' +
    '<div class="rev-row"><div><div style="font-weight:600;font-size:13px">https://api.boltnigeria.com/paylode/webhook</div>' +
    '<div style="font-size:11px;color:var(--gray-400)">Events: payment.success &middot; payment.failed &middot; refund.processed</div></div>' +
    '<div class="flex" style="gap:6px"><span class="badge badge-green">Active</span><button class="btn btn-outline btn-sm">Test</button></div></div></div>';
}

function renderMerchProfile() {
  var biz = [['Business Name','Bolt Nigeria Ltd'],['Category','Transport &amp; Ride-hailing'],['RC Number','RC 1240881'],
    ['CBN Merchant ID','MCH002'],['Processing Rate','1.2% (Growth Tier)'],['Account Manager','Taiwo Adeyemi']].map(function(r) {
    return '<div class="rev-row"><span class="rev-label">' + r[0] + '</span><span class="rev-value" style="font-size:12px">' + r[1] + '</span></div>';
  }).join('');
  var settle = [['Bank','Guaranty Trust Bank (GTB)'],['Account Name','Bolt Operations Nigeria Ltd'],
    ['Account Number','0123456789'],['Settlement Cycle','T+1 Business Day'],['Auto-settle','Enabled']].map(function(r) {
    return '<div class="rev-row"><span class="rev-label">' + r[0] + '</span><span class="rev-value" style="font-size:12px">' + r[1] + '</span></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Business Profile</div></div><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Business Information</div><button class="btn btn-outline btn-sm">&#9998; Edit</button></div>' + biz + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Settlement Account</div><button class="btn btn-outline btn-sm">&#9998; Change</button></div>' + settle + '</div></div>';
}

function renderSdkStart() {
  var tab = sdkTabState();
  var samples = {
    js:     '<span class="comment">// Add to HTML head</span>\n&lt;script src="https://js.paylode.ng/v1/checkout.js"&gt;&lt;/script&gt;\n\n<span class="kw">const</span> handler = PaylodeCheckout.<span class="fn">setup</span>({\n  key: <span class="str">\'pk_live_bolt_x9k3m2p8q4r1\'</span>,\n  email: customer.email,\n  amount: <span class="num">5000000</span>,\n  currency: <span class="str">\'NGN\'</span>,\n  ref: <span class="fn">generateRef</span>(),\n  callback: (r) =&gt; <span class="fn">verifyOnServer</span>(r.reference),\n  onClose: () =&gt; console.<span class="fn">log</span>(<span class="str">\'closed\'</span>)\n});\ndocument.<span class="fn">getElementById</span>(<span class="str">\'pay-btn\'</span>).<span class="fn">addEventListener</span>(<span class="str">\'click\'</span>, () =&gt; handler.<span class="fn">openIframe</span>());',
    node:   '<span class="comment">// npm install paylode-node</span>\n<span class="kw">const</span> Paylode = <span class="fn">require</span>(<span class="str">\'paylode-node\'</span>);\n<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">Paylode</span>(<span class="str">\'sk_live_bolt_...\'</span>);\n<span class="kw">const</span> txn = <span class="kw">await</span> client.transaction.<span class="fn">initialize</span>({\n  email: <span class="str">\'customer@example.com\'</span>,\n  amount: <span class="num">5000000</span>,\n  reference: <span class="str">\'TXN-\'</span> + Date.<span class="fn">now</span>(),\n  callback_url: <span class="str">\'https://yoursite.com/callback\'</span>\n});\nres.<span class="fn">redirect</span>(txn.data.authorization_url);',
    python: '<span class="comment"># pip install paylode-python</span>\n<span class="kw">import</span> paylode\nclient = paylode.<span class="fn">Paylode</span>(<span class="str">\'sk_live_bolt_...\'</span>)\ntxn = client.transaction.<span class="fn">initialize</span>(\n    email=<span class="str">\'customer@example.com\'</span>,\n    amount=<span class="num">5000000</span>,\n    reference=<span class="fn">generate_ref</span>()\n)\n<span class="kw">return</span> redirect(txn[<span class="str">\'data\'</span>][<span class="str">\'authorization_url\'</span>])',
    php:    '<span class="comment">// composer require paylode/paylode-php</span>\n<span class="kw">use</span> Paylode\\Paylode;\n$client = <span class="kw">new</span> <span class="fn">Paylode</span>(<span class="str">\'sk_live_bolt_...\'</span>);\n$txn = $client-&gt;transaction-&gt;<span class="fn">initialize</span>([\n    <span class="str">\'email\'</span> =&gt; <span class="str">\'customer@example.com\'</span>,\n    <span class="str">\'amount\'</span> =&gt; <span class="num">5000000</span>\n]);\nheader(<span class="str">\'Location: \'</span> . $txn[<span class="str">\'data\'</span>][<span class="str">\'authorization_url\'</span>]);'
  };
  var tabBtns = ['js','node','python','php'].map(function(l) {
    return '<button class="tab-btn ' + (tab===l?'active':'') + '" onclick="setSdkTab(\'' + l + '\')">' +
           ({js:'JavaScript',node:'Node.js',python:'Python',php:'PHP'})[l] + '</button>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Quick Start Guide</div>' +
    '<div class="page-desc">Integrate Paylode payments in minutes</div></div>' +
    '<div class="card"><div class="tab-nav">' + tabBtns + '</div>' +
    '<div class="code-block">' + samples[tab] + '</div></div>';
}

function renderSdkPayments() {
  return '<div class="page-header"><div class="page-title">Payments API</div></div><div class="card">' +
    '<div class="flex-between" style="margin-bottom:12px"><div><span class="badge badge-green" style="font-size:12px">POST</span> ' +
    '<span class="mono" style="font-size:13px">/v1/transaction/initialize</span></div><span class="badge badge-amber">Requires Secret Key</span></div>' +
    '<div class="code-block">{\n  <span class="str">"email"</span>: <span class="str">"customer@example.com"</span>,\n  <span class="str">"amount"</span>: <span class="num">5000000</span>,\n  <span class="str">"currency"</span>: <span class="str">"NGN"</span>,\n  <span class="str">"reference"</span>: <span class="str">"TXN-20250526-001"</span>,\n  <span class="str">"channels"</span>: [<span class="str">"card"</span>, <span class="str">"bank_transfer"</span>]\n}</div>' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700);margin:12px 0 8px">Success Response (201)</div>' +
    '<div class="code-block">{\n  <span class="str">"status"</span>: <span class="kw">true</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"authorization_url"</span>: <span class="str">"https://checkout.paylode.ng/pay/abc123"</span>,\n    <span class="str">"reference"</span>: <span class="str">"TXN-20250526-001"</span>\n  }\n}</div></div>';
}

function renderSdkVerify() {
  return '<div class="page-header"><div class="page-title">Verify Payment</div></div>' +
    '<div class="warn-box" style="margin-bottom:16px">&#9888; Always verify server-side before fulfilling orders.</div>' +
    '<div class="card"><div class="flex-between" style="margin-bottom:12px">' +
    '<span class="badge badge-blue" style="font-size:12px">GET</span> ' +
    '<span class="mono" style="font-size:13px">/v1/transaction/verify/:reference</span></div>' +
    '<div class="code-block">app.<span class="fn">post</span>(<span class="str">\'/callback\'</span>, <span class="kw">async</span> (req, res) =&gt; {\n  <span class="kw">const</span> txn = <span class="kw">await</span> client.transaction.<span class="fn">verify</span>(req.body.reference);\n  <span class="kw">if</span> (txn.data.status === <span class="str">\'success\'</span>) {\n    <span class="kw">await</span> <span class="fn">fulfillOrder</span>(txn.data.metadata.order_id);\n    res.<span class="fn">json</span>({ ok: <span class="kw">true</span> });\n  }\n});</div></div>';
}

function renderSdkWebhookDocs() {
  var evts = [['payment.success','Transaction completed','badge-green','success'],['payment.failed','Transaction failed','badge-red','failed'],
    ['payment.pending','Awaiting confirmation','badge-amber','pending'],['refund.processed','Refund processed','badge-blue','processed'],
    ['settlement.completed','Settlement disbursed','badge-purple','completed'],['chargeback.raised','Dispute raised','badge-red','raised']].map(function(e) {
    return '<div class="rev-row"><div><span class="mono" style="font-size:12px">' + e[0] + '</span>' +
           '<div style="font-size:11px;color:var(--gray-400)">' + e[1] + '</div></div><span class="badge ' + e[2] + '">' + e[3] + '</span></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Webhooks</div></div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Available Events</div></div>' + evts + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Signature Verification</div></div>' +
    '<div class="code-block"><span class="kw">const</span> crypto = <span class="fn">require</span>(<span class="str">\'crypto\'</span>);\n<span class="kw">function</span> <span class="fn">verifyWebhook</span>(payload, sig, secret) {\n  <span class="kw">const</span> hash = crypto.<span class="fn">createHmac</span>(<span class="str">\'sha512\'</span>, secret)\n    .<span class="fn">update</span>(JSON.<span class="fn">stringify</span>(payload)).<span class="fn">digest</span>(<span class="str">\'hex\'</span>);\n  <span class="kw">return</span> hash === sig;\n}</div></div>';
}

function renderSdkMobile() {
  return '<div class="page-header"><div class="page-title">Mobile SDKs</div></div><div class="grid-2">' +
    '<div class="card"><div style="font-size:18px;margin-bottom:8px">&#128241; Android (Kotlin)</div>' +
    '<div class="code-block"><span class="comment">// build.gradle</span>\nimplementation <span class="str">\'ng.paylode:android-sdk:1.4.0\'</span>\n\n<span class="kw">val</span> p = PaylodeSDK.<span class="fn">Builder</span>(this).<span class="fn">setPublicKey</span>(<span class="str">"pk_live_..."</span>).<span class="fn">build</span>()\np.<span class="fn">charge</span>(email=<span class="str">"user@email.com"</span>, amount=<span class="num">5000000</span>, onSuccess={ ref -&gt; <span class="fn">verify</span>(ref) })</div></div>' +
    '<div class="card"><div style="font-size:18px;margin-bottom:8px">&#127822; iOS (Swift)</div>' +
    '<div class="code-block"><span class="kw">let</span> config = PaylodeConfig(publicKey: <span class="str">"pk_live_..."</span>, email: <span class="str">"user@email.com"</span>, amount: <span class="num">5000000</span>)\nPaylodeCheckout.<span class="fn">present</span>(config, from: self) { result <span class="kw">in</span>\n  <span class="kw">switch</span> result {\n  <span class="kw">case</span> .<span class="fn">success</span>(<span class="kw">let</span> ref): <span class="fn">verify</span>(ref)\n  <span class="kw">case</span> .<span class="fn">failure</span>(<span class="kw">let</span> e): <span class="fn">showError</span>(e)\n  }\n}</div></div></div>';
}

function renderSdkErrors() {
  var rows = [['E001','401','Invalid API key','Verify your secret key'],['E002','400','Invalid amount','Amount in kobo, min &#8358;100'],
    ['E003','400','Duplicate reference','Use unique reference per transaction'],['E004','404','Transaction not found','Check reference is correct'],
    ['E005','422','Card declined','Ask customer for different card'],['E006','422','Insufficient funds','Notify customer to top up'],
    ['E007','429','Rate limit exceeded','Implement exponential backoff'],['E008','503','Rail unavailable','Retry with alternative channel']].map(function(e) {
    return '<tr><td class="mono" style="color:var(--red)">' + e[0] + '</td><td><span class="badge badge-gray">' + e[1] + '</span></td>' +
           '<td style="font-size:12px">' + e[2] + '</td><td style="font-size:12px;color:var(--gray-500)">' + e[3] + '</td></tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Error Codes</div></div>' +
    '<div class="card"><div class="table-wrap"><table>' +
    '<thead><tr><th>Code</th><th>HTTP</th><th>Message</th><th>Action</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function renderSdkTestCards() {
  var rows = [['4084084084084081','12/99','408','0000','Successful payment'],['4084080000000409','12/99','409','0000','Insufficient funds'],
    ['4187427415564246','09/99','828','3310','Network timeout'],['5399835012521735','10/99','564','3310','Success &mdash; no PIN'],
    ['4000000000000002','12/99','123','1234','Card declined']].map(function(c) {
    return '<tr>' + c.map(function(v,i){ return '<td class="' + (i<4?'mono':'') + '" style="font-size:' + (i<4?12:13) + 'px">' + v + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="page-header"><div class="page-title">Test Cards &amp; Credentials</div>' +
    '<div class="page-desc">Use with pk_test_... / sk_test_... keys only</div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Test Card Numbers</div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Card Number</th><th>Expiry</th><th>CVV</th><th>PIN</th><th>Behaviour</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

function showMerchantRateModal(id) {
  var m = MERCHANTS.filter(function(x){ return x.id===id; })[0];
  var agg = m.aggregator ? AGGREGATORS.filter(function(a){ return a.id===m.aggregator; })[0] : null;
  showModal('<div class="modal-header"><div class="modal-title">Configure Rate &mdash; ' + m.name + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Current rate: <strong>' + m.rate + '%</strong></div>' +
    '<div class="form-group"><label class="form-label">Processing Rate (%)</label>' +
    '<input class="form-input" type="number" value="' + m.rate + '" step="0.1" min="0.1" max="5"></div>' +
    '<div class="form-group"><label class="form-label">Aggregator Split Override (%)</label>' +
    '<input class="form-input" type="number" value="' + (agg?agg.split:0) + '" ' + (!m.aggregator?'disabled':'') + '>' +
    (!m.aggregator ? '<div class="form-hint">No aggregator &mdash; all net goes to Paylode</div>' : '') + '</div>' +
    '<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" rows="2" placeholder="Reason for custom rate..."></textarea></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Rate updated!\');document.getElementById(\'modal\').style.display=\'none\'">Save Rate Config</button></div>');
}

function showAddMerchantModal() {
  var opts = AGGREGATORS.map(function(a){ return '<option value="' + a.id + '">' + a.name + '</option>'; }).join('');
  showModal('<div class="modal-header"><div class="modal-title">Add New Merchant</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Business Name</label><input class="form-input" placeholder="e.g. Konga Nigeria"></div>' +
    '<div class="form-grid"><div class="form-group"><label class="form-label">Category</label>' +
    '<select class="form-input form-select"><option>Retail</option><option>E-commerce</option><option>Transport</option><option>Education</option><option>Healthcare</option></select></div>' +
    '<div class="form-group"><label class="form-label">Processing Rate (%)</label><input class="form-input" type="number" value="1.5" step="0.1"></div></div>' +
    '<div class="form-group"><label class="form-label">Assign to Aggregator</label>' +
    '<select class="form-input form-select"><option value="">None (Direct Merchant)</option>' + opts + '</select></div>' +
    '<div class="form-group"><label class="form-label">Contact Email</label><input class="form-input" type="email" placeholder="cto@merchant.com"></div>' +
    '<div class="flex-between" style="margin-top:8px"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Merchant created!\');document.getElementById(\'modal\').style.display=\'none\'">Create &amp; Send Invite</button></div>');
}

function showAddAggModal() {
  showModal('<div class="modal-header"><div class="modal-title">Add New Aggregator</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Company Name</label><input class="form-input" placeholder="e.g. Bridge Payments Ltd"></div>' +
    '<div class="form-group"><label class="form-label">Owner / Contact Person</label><input class="form-input" placeholder="Full name"></div>' +
    '<div class="form-group"><label class="form-label">Contact Email</label><input class="form-input" type="email"></div>' +
    '<div class="form-group"><label class="form-label">Revenue Split (%)</label><input class="form-input" type="number" value="30" min="5" max="60">' +
    '<div class="form-hint">% of net revenue (after rail costs) shared with this aggregator</div></div>' +
    '<div class="flex-between" style="margin-top:8px"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Aggregator created!\');document.getElementById(\'modal\').style.display=\'none\'">Create Aggregator</button></div>');
}

function showEditAggModal(id) {
  var a = AGGREGATORS.filter(function(x){ return x.id===id; })[0];
  showModal('<div class="modal-header"><div class="modal-title">Edit Revenue Split &mdash; ' + a.name + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Revenue Split (%)</label><input class="form-input" type="number" value="' + a.split + '" min="5" max="60"></div>' +
    '<div class="form-group"><label class="form-label">Effective Date</label><input class="form-input" type="date" value="2025-06-01"></div>' +
    '<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" rows="2"></textarea></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Split updated!\');document.getElementById(\'modal\').style.display=\'none\'">Save Changes</button></div>');
}

function showEditRailModal(rail) {
  var c = RAIL_COSTS[rail];
  showModal('<div class="modal-header"><div class="modal-title">Edit Rail Cost &mdash; ' + rail + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="warn-box" style="margin-bottom:16px;font-size:12px">Update when your agreement with ' + rail + ' changes.</div>' +
    '<div class="form-group"><label class="form-label">Transfer Rate (%)</label><input class="form-input" type="number" value="' + (c.transfer*100).toFixed(2) + '" step="0.01"></div>' +
    '<div class="form-group"><label class="form-label">Card Rate (%)</label><input class="form-input" type="number" value="' + (c.card*100).toFixed(2) + '" step="0.01"></div>' +
    '<div class="form-group"><label class="form-label">USSD Rate (%)</label><input class="form-input" type="number" value="' + (c.ussd*100).toFixed(2) + '" step="0.01"></div>' +
    '<div class="form-group"><label class="form-label">Effective Date</label><input class="form-input" type="date" value="2025-05-01"></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Rail cost updated!\');document.getElementById(\'modal\').style.display=\'none\'">Save Rail Cost</button></div>');
}

function showAddRailModal() {
  showModal('<div class="modal-header"><div class="modal-title">Add New Payment Rail</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Rail / Bank Name</label><input class="form-input" placeholder="e.g. First Bank Direct"></div>' +
    '<div class="form-group"><label class="form-label">Transfer Rate (%)</label><input class="form-input" type="number" step="0.01" placeholder="0.50"></div>' +
    '<div class="form-group"><label class="form-label">Card Rate (%)</label><input class="form-input" type="number" step="0.01" placeholder="1.50"></div>' +
    '<div class="form-group"><label class="form-label">USSD Rate (%)</label><input class="form-input" type="number" step="0.01" placeholder="0.80"></div>' +
    '<div class="form-group"><label class="form-label">Integration Status</label>' +
    '<select class="form-input form-select"><option>Cost Config Only (Pre-integration)</option><option>Testing</option><option>Live</option></select></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="alert(\'Rail added!\');document.getElementById(\'modal\').style.display=\'none\'">Add Rail</button></div>');
}

function toggleWebhookSecret() {
  var input = document.getElementById('wh-secret');
  if (input) {
    var btn = input.nextElementSibling;
    var eye = btn.querySelector('.eye-icon');
    var eyeSlash = btn.querySelector('.eye-slash-icon');
    if (input.type === 'password') {
      input.type = 'text';
      eye.style.display = 'none';
      eyeSlash.style.display = 'block';
    } else {
      input.type = 'password';
      eye.style.display = 'block';
      eyeSlash.style.display = 'none';
    }
  }
}

renderNav();
renderPage();
