// ────────────────────────────────────────────────
// PAYLODE GATEWAY — app.js  (syntax-safe rewrite)
// ────────────────────────────────────────────────

var currentRole = 'superadmin';
var currentPage = 'overview';
var __navOpen   = { 'USERS': true };  // USERS section open by default

function toggleNav(section) {
  __navOpen[section] = !__navOpen[section];
  renderNav();
}

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

// Shared Developer/SDK nav block — shown to SA, merchants and aggregators (#4).
// All sdk_* pages are static (renderSdk*); loadPageData no-ops them.
var DEV_SDK_ITEMS = [
  {id:'sdk_start',    icon:'▶', label:'Quick Start'    },
  {id:'sdk_payments', icon:'₦', label:'Card Payments'  },
  {id:'sdk_va',       icon:'⇆', label:'Virtual Accounts'},
  {id:'sdk_payouts',  icon:'⇄', label:'Payouts (Send)' },
  {id:'sdk_verify',   icon:'✓', label:'Verify Payment' },
  {id:'sdk_webhook',  icon:'⇀', label:'Webhooks'       },
  {id:'sdk_mobile',   icon:'□', label:'Published SDKs' },
  {id:'sdk_errors',   icon:'!', label:'Error Codes'    },
  {id:'sdk_test',     icon:'⚡', label:'Test Cards'     },
];

// Sidebar = section entries. Single-item sections link straight to the page
// (e.g. Dashboard stays a direct analytics link); multi-item sections open a
// card HUB (renderSectionHub). Icons per section below.
var SECTION_ICON = {
  'Dashboard':'◉', 'Users':'▦', 'Operations':'⚙', 'Reports':'▤', 'System Config':'⚙',
  'Developer':'▶', 'Management':'▦', 'Finance':'₦', 'Merchants':'▦', 'Transactions':'↕',
  'Payouts':'⇄', 'Integration':'⚿', 'Account':'⊙', 'System':'⊕', 'SDK':'▶', 'Reference':'!',
  'Payment Links & QR Code':'🔗',
};
var NAV = {
  superadmin: [
    { section:'Dashboard', items:[ {id:'overview', icon:'◉', label:'Dashboard'} ]},
    { section:'Users', items:[
      {id:'merchants',     icon:'▦', label:'Merchants'       },
      {id:'aggregators',   icon:'⬡', label:'Aggregators'     },
      {id:'admin_onboard', icon:'+', label:'Onboard Merchant'},
      {id:'users',         icon:'⊕', label:'Users & Permissions'},
    ]},
    { section:'Operations', items:[
      {id:'transactions',    icon:'↕', label:'Transactions'    },
      {id:'settlement',      icon:'✓', label:'Settlements'     },
      {id:'wallets',         icon:'◈', label:'Merchant Wallets'},
      {id:'compliance',      icon:'⚖', label:'KYC Review'      },
      {id:'deferrals',       icon:'⧗', label:'KYC Docs & Deferrals'},
      {id:'compliance_exceptions', icon:'⚑', label:'Intl / Mastercard Compliance'},
      {id:'compliance_centre', icon:'▣', label:'Compliance Centre'},
      {id:'onboarding_apps', icon:'▤', label:'Applications'    },
    ]},
    { section:'Reports', items:[
      {id:'revenue',         icon:'₦', label:'Revenue Report'  },
      {id:'vat_report',      icon:'⊟', label:'VAT Report'      },
      {id:'cbn_report',      icon:'⊡', label:'CBN Report'      },
      {id:'payout_report',   icon:'⇄', label:'Payout Report'   },
      {id:'rail_settlement', icon:'⊞', label:'Rail Settlement' },
    ]},
    { section:'System Config', items:[
      {id:'service_providers',   icon:'◈', label:'Service Providers'},
      {id:'fee_config',          icon:'₦', label:'Merchant Pricing'},
      {id:'rails',               icon:'⊞', label:'Rail Configuration'},
      {id:'settle_verification', icon:'⊙', label:'Bank Verification'},
      {id:'email_tpl',           icon:'✉', label:'Email Templates'  },
      {id:'activity_log',        icon:'☰', label:'Activity Log'     },
      {id:'sa_connections',      icon:'📡', label:'Connections'      },
      {id:'sa_reconciliation',   icon:'⇄', label:'Reconciliation'   },
      {id:'invite_tracking',     icon:'✉', label:'Invite Tracking'  },
      {id:'sa_wallet',           icon:'👛', label:'Wallet Approvals' },
      {id:'settings',            icon:'⚙', label:'Settings'         },
    ]},
    { section:'Developer', items:DEV_SDK_ITEMS },
  ],
  admin: [
    { section:'Dashboard',  items:[{id:'overview',icon:'◉',label:'Dashboard'}]},
    { section:'Management',  items:[{id:'transactions',icon:'↕',label:'All Transactions'},{id:'merchants',icon:'▦',label:'Merchants'},{id:'aggregators',icon:'⬡',label:'Aggregators'},{id:'admin_onboard',icon:'+',label:'Onboard Merchant'}]},
    { section:'Operations',  items:[{id:'settlement',icon:'✓',label:'Settlement'},{id:'wallets',icon:'◈',label:'Merchant Wallets'},{id:'compliance',icon:'⚖',label:'KYC Review'},{id:'deferrals',icon:'⧗',label:'KYC Docs & Deferrals'},{id:'compliance_exceptions',icon:'⚑',label:'Intl / Mastercard Compliance'},{id:'compliance_centre',icon:'▣',label:'Compliance Centre'},{id:'onboarding_apps',icon:'▤',label:'Applications'},{id:'revenue',icon:'₦',label:'Revenue (Read-Only)'}]},
    { section:'System',      items:[{id:'users',icon:'⊕',label:'Invite Users'},{id:'activity_log',icon:'☰',label:'Activity Log'},{id:'invite_tracking',icon:'✉',label:'Invite Tracking'}]},
    { section:'Developer',   items:DEV_SDK_ITEMS },
  ],
  aggregator: [
    { section:'Dashboard',  items:[{id:'agg_overview',icon:'◉',label:'Dashboard'}]},
    { section:'Merchants',  items:[{id:'agg_merchants',icon:'▦',label:'My Merchants'},{id:'agg_onboard',icon:'+',label:'Onboard Merchant'}]},
    { section:'Finance',    items:[{id:'agg_revenue',icon:'₦',label:'Revenue Share'},{id:'agg_transactions',icon:'↕',label:'Transactions'}]},
    { section:'Developer',  items:DEV_SDK_ITEMS },
  ],
  merchant: [
    { section:'Dashboard',    items:[{id:'merch_overview',icon:'◉',label:'Dashboard'}]},
    { section:'Transactions', items:[{id:'merch_transactions',icon:'↕',label:'Transactions'},{id:'merch_settlements',icon:'✓',label:'Settlements'},{id:'merch_reconciliation',icon:'⇄',label:'Reconciliation'}]},
    { section:'Payment Links & QR Code', items:[{id:'merch_payments',icon:'🔗',label:'Payment Links & QR Code'}]},
    { section:'Invoice & Collect', items:[{id:'merch_invoicing',icon:'🧾',label:'Invoice & Collect'}]},
    { section:'Billspay', items:[{id:'merch_wallet',icon:'👛',label:'Billspay'}]},
    { section:'Payouts',      items:[{id:'payouts',icon:'⇄',label:'Send Payouts'},{id:'payout_logs',icon:'≡',label:'Payout Logs'}]},
    { section:'Integration',  items:[{id:'merch_apikeys',icon:'⚿',label:'API Keys'},{id:'merch_webhooks',icon:'⇀',label:'Webhooks'}]},
    { section:'Developer',    items:DEV_SDK_ITEMS },
    { section:'Account',      items:[{id:'merch_profile',icon:'⊙',label:'Business Profile'}]},
  ],
  developer: [
    { section:'SDK',       items:[
      {id:'sdk_start',    icon:'▶',label:'Quick Start'       },
      {id:'sdk_payments', icon:'₦',label:'Card Payments'     },
      {id:'sdk_va',       icon:'⇆',label:'Virtual Accounts'  },
      {id:'sdk_payouts',  icon:'⇄',label:'Payouts (Send)'    },
      {id:'sdk_verify',   icon:'✓',label:'Verify Payment'    },
      {id:'sdk_webhook',  icon:'⇀',label:'Webhooks'          },
      {id:'sdk_mobile',   icon:'□',label:'Published SDKs'    },
    ]},
    { section:'Reference', items:[{id:'sdk_errors',icon:'!',label:'Error Codes'},{id:'sdk_test',icon:'⚡',label:'Test Cards'}]},
  ],
};

var ROLE_META = {
  superadmin: { label:'Super Admin', name:'Paylode HQ',         title:'Super Admin Dashboard', defaultPage:'overview'       },
  admin:       { label:'Admin',       name:'Paylode Admin',      title:'Admin Dashboard',       defaultPage:'overview'       },
  compliance:  { label:'Compliance',  name:'Compliance',         title:'Compliance Dashboard',  defaultPage:'compliance'     },
  audit:       { label:'Audit',       name:'Audit',              title:'Audit Dashboard',       defaultPage:'transactions'   },
  aggregator:  { label:'Aggregator',  name:'FinConnect Nigeria', title:'Aggregator Dashboard',  defaultPage:'agg_overview'   },
  merchant:    { label:'Merchant',    name:'Bolt Nigeria',       title:'Merchant Dashboard',    defaultPage:'merch_overview' },
  developer:   { label:'Developer',   name:'API / SDK Docs',     title:'Developer SDK',         defaultPage:'sdk_start'      },
};
// Compliance & Audit use the SA nav superset, reduced by their view permissions
// (see renderNav + NAV_PERM). SUPER_ADMIN still bypasses all filtering.
NAV.compliance = NAV.superadmin;
NAV.audit      = NAV.superadmin;

// ── Permission definitions (mirrors backend src/config/permissions.js) ────────
// Functionality-based: each functionality has a View perm and (where edit:true)
// an Edit perm. Granting both View+Edit == "All" for that functionality.
var FUNCTIONALITIES = [
  { id:'dashboard',        label:'Dashboard Overview',                     edit:false },
  { id:'transactions',     label:'Transactions',                           edit:true,  editLabel:'Export / refund' },
  { id:'merchants',        label:'Merchants',                              edit:true },
  { id:'merchant_contact', label:'Merchant / Aggregator Contact Details',  edit:false, sensitive:true },
  { id:'aggregators',      label:'Aggregators',                            edit:true },
  { id:'onboarding',       label:'Onboarding / Applications',              edit:true,  editLabel:'Onboard / submit' },
  { id:'compliance',       label:'Compliance / KYC Review',                edit:true,  editLabel:'Approve / reject' },
  { id:'doc_referrals',    label:'Document Referrals',                     edit:true,  editLabel:'Request / resolve' },
  { id:'settlements',      label:'Settlements',                            edit:true,  editLabel:'Approve / process' },
  { id:'payouts',          label:'Payouts',                                edit:true,  editLabel:'Process / mark paid' },
  { id:'wallets',          label:'Merchant Wallets / Credit',              edit:true,  editLabel:'Fund / adjust' },
  { id:'chargebacks',      label:'Chargebacks',                            edit:true,  editLabel:'Resolve' },
  { id:'reports',          label:'Reports',                                edit:true,  editLabel:'Download' },
  { id:'revenue',          label:'Revenue',                                edit:false },
  { id:'rails',            label:'Payment Rails',                          edit:true },
  { id:'fees',             label:'Merchant Pricing',                       edit:true },
  { id:'email_tpl',        label:'Email Templates',                        edit:true },
  { id:'webhooks',         label:'Webhooks',                               edit:true },
  { id:'staff',            label:'Staff Accounts',                         edit:true,  editLabel:'Create / manage' },
  { id:'settings',         label:'Platform Settings',                      edit:true },
  { id:'audit_log',        label:'Activity / Audit Log',                   edit:false },
];
function viewPerm(id){ return 'view_' + id; }
function editPerm(id){ return 'edit_' + id; }
function _grant(ids, withEdit){
  var out = [];
  ids.forEach(function(id){
    out.push(viewPerm(id));
    if (withEdit){ var f = FUNCTIONALITIES.filter(function(x){return x.id===id;})[0]; if (f && f.edit) out.push(editPerm(id)); }
  });
  return out;
}
var PERM_ROLE_DEFAULTS = {
  SUPER_ADMIN: _grant(FUNCTIONALITIES.map(function(f){ return f.id; }), true),
  ADMIN: _grant(['dashboard','revenue'],false)
    .concat(_grant(['transactions','merchants','aggregators','onboarding','compliance','doc_referrals','settlements','payouts','wallets','chargebacks','reports','rails','webhooks'],true))
    .concat(_grant(['staff'],false)),
  COMPLIANCE_OFFICER: _grant(['merchants','aggregators','transactions'],false)
    .concat(_grant(['compliance','doc_referrals','reports'],true)),
  AUDIT: _grant(['transactions','merchants','aggregators','settlements','payouts','chargebacks','compliance','revenue','audit_log'],false)
    .concat(_grant(['reports'],true)),
  MERCHANT: _grant(['dashboard','transactions','settlements','reports'],false).concat(_grant(['webhooks'],true)),
  AGGREGATOR: _grant(['dashboard','transactions','settlements','merchants','reports'],false).concat(_grant(['onboarding'],true)),
};

// nav item id → view perm required to see it (staff/SA nav only; SA bypasses).
var NAV_PERM = {
  merchants:'view_merchants', aggregators:'view_aggregators', admin_onboard:'edit_onboarding',
  deferrals:'view_doc_referrals', users:'view_staff', overview:'view_dashboard',
  transactions:'view_transactions', settlement:'view_settlements', rail_settlement:'view_settlements',
  payout_report:'view_payouts', wallets:'view_wallets', revenue:'view_revenue', vat_report:'view_reports', reports_hub:'view_reports', cbn_report:'view_reports', compliance:'view_compliance', compliance_centre:'view_compliance', compliance_exceptions:'view_compliance',
  onboarding_apps:'view_onboarding', invite_tracking:'view_audit_log', fee_config:'view_fees', rails:'view_rails', service_providers:'view_rails',
  settle_verification:'edit_settlements', email_tpl:'view_email_tpl', settings:'view_settings',
  activity_log:'view_audit_log', sa_connections:'view_audit_log', sa_reconciliation:'view_settlements', merch_reconciliation:'view_settlements',
};
// Does the logged-in user hold this permission? (SUPER_ADMIN bypasses everything.)
// Self-healing: a user whose stored permissions predate the view_/edit_ vocab
// (legacy panel_/action_ or empty) falls back to their role defaults so we never
// lock out existing staff before the data is re-seeded.
function userHasPerm(perm){
  if (!perm) return true;
  if (currentRole === 'superadmin') return true;
  try {
    var u = JSON.parse(sessionStorage.getItem('paylode_user') || '{}');
    var perms = Array.isArray(u.permissions) ? u.permissions : [];
    var hasNewVocab = perms.some(function(p){ return p.indexOf('view_') === 0 || p.indexOf('edit_') === 0; });
    if (!hasNewVocab) perms = PERM_ROLE_DEFAULTS[(u.role||'').toUpperCase()] || [];
    return perms.indexOf(perm) !== -1;
  } catch(e){ return false; }
}

function renderNav() {
  var meta = ROLE_META[currentRole];
  document.getElementById('role-label').textContent   = meta.label;
  document.getElementById('topbar-title').textContent = meta.title;
  // Use real business/company name from JWT if available
  var _u = {};
  try { _u = JSON.parse(sessionStorage.getItem('paylode_user') || '{}'); } catch(e) {}
  var _name = _u.businessName || _u.companyName || _u.organizationName ||
              (_u.firstName ? (_u.firstName + ' ' + (_u.lastName||'')).trim() : null) || meta.name;
  document.getElementById('role-name').textContent = _name;
  var container = document.getElementById('nav-items');
  // Filter nav items by the user's view permissions (SUPER_ADMIN bypasses).
  var nav = (NAV[currentRole] || []).map(function(sec) {
    return { section: sec.section, items: sec.items.filter(function(item) {
      return userHasPerm(NAV_PERM[item.id]);
    }) };
  }).filter(function(sec) { return sec.items.length > 0; });
  // Sidebar = one entry per section. Single-item section → links straight to the
  // page (Dashboard stays a direct analytics link). Multi-item → opens a card hub.
  container.innerHTML = nav.map(function(sec) {
    var single   = sec.items.length === 1 ? sec.items[0] : null;
    var targetId = single ? single.id : ('hub::' + sec.section);
    var active   = (currentPage === targetId) || sec.items.some(function(i){ return i.id === currentPage; });
    var icon     = single ? single.icon : (SECTION_ICON[sec.section] || '▦');
    var label    = single ? single.label : sec.section;
    return '<div class="nav-item ' + (active ? 'active' : '') + '" onclick="navigate(\'' + targetId.replace(/'/g,"\\'") + '\')">' +
           '<span class="nav-icon">' + icon + '</span>' + label + '</div>';
  }).join('');
  document.querySelectorAll('.role-btn').forEach(function(btn, i) {
    btn.classList.toggle('active', ['superadmin','admin','aggregator','merchant','developer'][i] === currentRole);
  });
}

// Generic section hub: a grid of cards for a section's (permitted) pages.
function renderSectionHub(sectionName) {
  var sec = (NAV[currentRole] || []).filter(function(s){ return s.section === sectionName; })[0];
  if (!sec) return '<div class="page-header"><div class="page-title">' + sectionName + '</div></div>';
  var items = sec.items.filter(function(i){ return userHasPerm(NAV_PERM[i.id]); });
  var cards = items.map(function(i){
    return '<div class="card" style="cursor:pointer;text-align:center;transition:box-shadow .15s" ' +
      'onclick="navigate(\'' + i.id.replace(/'/g,"\\'") + '\')" ' +
      'onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.10)\'" onmouseout="this.style.boxShadow=\'\'">' +
      '<div style="font-size:30px;margin-bottom:10px">' + i.icon + '</div>' +
      '<div style="font-weight:600;font-size:14px">' + i.label + '</div></div>';
  }).join('');
  return '<div class="page-header"><div class="page-title">' + sectionName + '</div>' +
    '<div class="page-desc">Choose a ' + sectionName.toLowerCase() + ' page</div></div>' +
    '<div class="grid-3">' + (cards || '<div class="card">No pages available</div>') + '</div>';
}

function switchRole(role) { currentRole = role; currentPage = ROLE_META[role].defaultPage; renderNav(); renderPage(); closeSidebar(); }
var __navHistory = [];
// Nav ids that live on a standalone static page rather than an in-app view.
var EXTERNAL_PAGES = { merch_invoicing: 'invoicing.html?v=20260705c', merch_wallet: 'wallet-admin.html', sa_wallet: 'wallet-sa.html' };
function navigate(page)   {
  if (EXTERNAL_PAGES[page]) { window.location.href = EXTERNAL_PAGES[page]; return; }
  if (currentPage && currentPage !== page && String(page).indexOf('hub::') !== 0) __navHistory.push(currentPage);
  currentPage = page; renderNav(); renderPage(); closeSidebar();
}
// Go back to the PREVIOUS page (not always the dashboard). Falls back to the role's
// default page when there's no history to pop.
function goBack() {
  var prev = __navHistory.pop();
  if (!prev) prev = (ROLE_META[currentRole] && ROLE_META[currentRole].defaultPage) || 'overview';
  currentPage = prev; renderNav(); renderPage(); closeSidebar();
}
window.goBack = goBack;

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  var s = document.getElementById('sidebar');
  var o = document.getElementById('sidebar-overlay');
  if (s) s.classList.remove('open');
  if (o) o.classList.remove('open');
}

function statusBadge(s) {
  var m = {active:'badge-green',success:'badge-green',completed:'badge-green',pending:'badge-amber',failed:'badge-red',suspended:'badge-red'};
  return '<span class="badge ' + (m[s] || 'badge-gray') + '">' + s + '</span>';
}
function showModal(html) { document.getElementById('modal-inner').innerHTML = html; document.getElementById('modal').style.display = 'flex'; }
function closeModal(e)   { if (e.target.id === 'modal') document.getElementById('modal').style.display = 'none'; }

// Universal modal-close safety net: guarantees EVERY modal is closable and shows a
// visible X — Escape closes it, and whenever the modal opens, if its content lacks
// a .modal-close button we inject a floating one (covers both showModal() and the
// direct modal-inner.innerHTML builders, current + future). Runs once on load.
(function () {
  function initModalSafety() {
    var modal = document.getElementById('modal');
    if (!modal) return;
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && modal.style.display !== 'none') modal.style.display = 'none';
    });
    var ensureCloseX = function () {
      if (modal.style.display === 'none') return;
      var inner = document.getElementById('modal-inner');
      if (!inner || inner.querySelector('.modal-close')) return;
      var x = document.createElement('button');
      x.className = 'modal-close';
      x.setAttribute('aria-label', 'Close');
      x.innerHTML = '&#10005;';
      x.style.cssText = 'position:absolute;top:14px;right:14px;z-index:10';
      x.onclick = function () { modal.style.display = 'none'; };
      if (getComputedStyle(inner).position === 'static') inner.style.position = 'relative';
      inner.insertBefore(x, inner.firstChild);
    };
    new MutationObserver(ensureCloseX).observe(modal, { attributes: true, attributeFilter: ['style'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initModalSafety);
  else initModalSafety();
})();
function sdkTabState()   { return window.__sdkTab || 'js'; }
function setSdkTab(t)    { window.__sdkTab = t; renderPage(); }

// Compliance Exceptions — Mastercard Rules screening dispositions (SA defer/clear/block)
// + the prohibited/restricted MCC reference matrix. Data loaded by loadComplianceExceptions
// / loadComplianceMatrix in api-wiring.js.
function complianceExcTab() { return window.__cmplExcTab || 'exceptions'; }
function setComplianceExcTab(t) { window.__cmplExcTab = t; renderPage(); loadPageData('compliance_exceptions'); }
function renderComplianceExceptions() {
  var tab = complianceExcTab();
  var tabBtn = function(id, label) {
    return '<button class="btn ' + (tab === id ? 'btn-lime' : 'btn-outline') + ' btn-sm" onclick="setComplianceExcTab(\'' + id + '\')">' + label + '</button>';
  };
  return '<div class="page-header"><div><h1 class="page-title">Compliance Exceptions</h1>' +
    '<p class="page-subtitle">Mastercard Rules screening findings — defer &amp; proceed, clear false positives, or confirm a block. Hard prohibitions require an explicit override.</p></div></div>' +
    '<div class="flex" style="gap:8px;margin-bottom:14px">' + tabBtn('exceptions', 'Exceptions') + tabBtn('matrix', 'Rule Matrix') + '</div>' +
    (tab === 'matrix'
      ? '<div id="cmpl-matrix"><div class="info-box">&#8987; Loading rule matrix…</div></div>'
      : '<div class="card" style="margin-bottom:12px"><div class="flex" style="gap:8px;align-items:flex-end;flex-wrap:wrap">' +
        '<div class="form-group" style="margin:0"><label class="form-label">Status</label>' +
        '<select class="form-input" id="cmpl-status" style="width:160px" onchange="loadComplianceExceptions()">' +
        '<option value="">All</option><option value="open">Open</option><option value="deferred">Deferred</option><option value="cleared">Cleared</option><option value="blocked">Blocked</option></select></div>' +
        '<button class="btn btn-outline btn-sm" onclick="loadComplianceExceptions()">&#8635; Refresh</button>' +
        '</div></div><div id="cmpl-exc"><div class="info-box">&#8987; Loading exceptions…</div></div>');
}

function renderPage() {
  var pages = {
    overview:renderSuperOverview, transactions:renderTransactions,
    merchants:renderMerchants, aggregators:renderAggregators,
    revenue:renderRevenueConfig, rails:renderRailCosts,
    settlement:renderSettlement, compliance:renderKycReview, compliance_centre:renderCompliance, settings:renderSettings,
    compliance_exceptions:renderComplianceExceptions, deferrals:renderDocDeferralsShell,
    activity_log:renderActivityLogShell,
    email_tpl:renderEmailTemplates,
    users:renderUserManagement,
    agg_overview:renderAggOverview, agg_merchants:renderAggMerchants,
    agg_onboard:renderAggOnboard, agg_revenue:renderAggRevenue,
    agg_transactions:renderAggTransactions,
    merch_overview:renderMerchOverview, merch_transactions:renderMerchTransactions,
    merch_settlements:renderMerchSettlements, merch_apikeys:renderMerchApiKeys,
    merch_payments:function(){ return '<div class="page-header"><div class="page-title">Payment Links</div></div><div class="card" style="text-align:center;padding:40px;color:#999">Loading…</div>'; },
    merch_webhooks:renderMerchWebhooks, merch_profile:renderMerchProfile,
    sdk_start:renderSdkStart, sdk_payments:renderSdkPayments,
    sdk_va:renderSdkVirtualAccounts,
    sdk_verify:renderSdkVerify, sdk_payouts:renderSdkPayouts,
    sdk_webhook:renderSdkWebhookDocs,
    sdk_mobile:renderSdkMobile, sdk_errors:renderSdkErrors, sdk_test:renderSdkTestCards,
  };
  if (currentPage && currentPage.indexOf('hub::') === 0) {
    document.getElementById('main-content').innerHTML = renderSectionHub(currentPage.slice(5));
    return;
  }
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
           '<td><button class="btn btn-outline btn-sm" onclick="viewMerchant(\'' + m.id + '\')">View</button>&nbsp;' +
           '<button class="btn btn-outline btn-sm" onclick="showMerchantRateModal(\'' + m.id + '\')">&#9881; Rate</button></td></tr>';
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

function editRateTier(name, rate, desc) {
  var rateNum = parseFloat(rate) || 1.5;
  document.getElementById('modal-inner').innerHTML =
    '<div class="modal-header"><div class="modal-title">Edit Rate Tier — ' + name + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">Changes apply to new merchants assigned this tier. Existing merchants keep their individually set rates unless manually updated.</div>' +
    '<div class="form-group"><label class="form-label">Tier Name</label><input class="form-input" id="tier-name" value="' + name + '"></div>' +
    '<div class="form-group"><label class="form-label">Processing Rate (%)</label><input class="form-input" id="tier-rate" type="number" step="0.1" min="0" max="5" value="' + rateNum + '"></div>' +
    '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="tier-desc" value="' + desc + '"></div>' +
    '<div class="flex-between" style="margin-top:4px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="saveRateTier()">Save Tier</button>' +
    '</div>';
  document.getElementById('modal').style.display = 'flex';
}
function saveRateTier() {
  var name = document.getElementById('tier-name').value;
  var rate = parseFloat(document.getElementById('tier-rate').value);
  if (!name || isNaN(rate)) { alert('Please fill in all fields'); return; }
  alert('Rate tier "' + name + '" updated to ' + rate.toFixed(1) + '%.\n\nNote: This affects new merchant assignments. Existing merchants require individual rate updates via Merchant Management.');
  document.getElementById('modal').style.display = 'none';
}

function renderRevenueConfig() {
  var tiers = [['Standard','1.5%','Default for new merchants'],['Growth (&#8358;50M+/mo)','1.2%','Auto-applied at threshold'],
    ['Enterprise (&#8358;200M+/mo)','0.9%','Manual application required'],['Non-Profit/NGO','0.5%','Requires CBN approval letter']];
  var tierHtml = tiers.map(function(row) {
    var safeName = row[0].replace(/&amp;/g,'&').replace(/&#8358;/g,'₦').replace(/&gt;/g,'>').replace(/&lt;/g,'<');
    return '<div class="rev-row"><div><div style="font-size:13px;font-weight:600">' + row[0] + '</div>' +
           '<div style="font-size:11px;color:var(--gray-400)">' + row[2] + '</div></div>' +
           '<div class="flex" style="gap:8px"><span class="badge badge-lime">' + row[1] + '</span>' +
           '<button class="btn btn-outline btn-sm" style="font-size:11px" onclick="editRateTier(\'' + safeName.replace(/'/g,"\\'") + '\',' + parseFloat(row[1]) + ',\'' + row[2].replace(/'/g,"\\'") + '\')">Edit</button></div></div>';
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

// ── Compliance Centre (tabbed) ────────────────────────────────────────────
function compTab() { return window.__compTab || 'overview'; }
function setCompTab(t) { window.__compTab = t; renderPage(); }

// Activity Log shell — body rendered by loadActivityLog() in api-wiring.js.
function renderActivityLogShell() {
  return '<div class="page-header"><div class="page-title">Activity Log</div></div>' +
    '<div class="card"><div style="padding:24px;text-align:center;color:var(--gray-400)">Loading&hellip;</div></div>';
}

// KYC Documents & Deferrals shell — body rendered by loadDeferrals() in api-wiring.js.
function renderDocDeferralsShell() {
  return '<div class="page-header"><div class="page-title">KYC Documents &amp; Deferrals</div></div>' +
    '<div class="card"><div style="padding:24px;text-align:center;color:var(--gray-400)">Loading&hellip;</div></div>';
}

// Domestic (Naira) KYC Review — review queue + AML/PEP + full merchant register.
// Body is rendered by loadCompliance() in api-wiring.js (it overwrites #main-content).
function renderKycReview() {
  return '<div class="page-header"><div class="page-title">KYC Review</div>' +
    '<div class="page-desc">Domestic merchant KYC, AML flags &amp; PEP &mdash; review queue and merchant register</div></div>' +
    '<div class="card"><div style="padding:24px;text-align:center;color:var(--gray-400)">Loading&hellip;</div></div>';
}

// Compliance Centre — regulatory obligations (CBN Returns / STR / NDPR / Retention).
function renderCompliance() {
  var tab = compTab();
  var tabs = [['overview','Overview'],['cbnn','CBN Returns'],['str','STR Filing'],['retention','Data Retention'],['ndpr','NDPR / Privacy']];
  var tabBtns = tabs.map(function(t) {
    return '<button class="tab-btn ' + (tab===t[0]?'active':'') + '" onclick="setCompTab(\'' + t[0] + '\')">' + t[1] + '</button>';
  }).join('');
  var pages = { overview:renderCompOverview, cbnn:renderCompCBNN, str:renderCompSTR, retention:renderCompRetention, ndpr:renderCompNDPR };
  return '<div class="page-header"><div class="page-title">Compliance Centre</div>' +
    '<div class="page-desc">Regulatory obligations, AML/CFT monitoring, and data governance &mdash; CBN, BOFIA &amp; NDPR</div></div>' +
    '<div class="tab-nav">' + tabBtns + '</div>' + (pages[tab] || renderCompOverview)();
}

function renderCompOverview() {
  var licenseHtml = [['License Type','Payment Solution Service Provider (PSSP)'],['License No','CBN/PAY/2024/001847'],
    ['Issued Date','2024-03-15'],['Expiry','2027-03-14'],['Status','Active &amp; Valid']].map(function(row) {
    return '<div class="rev-row"><span class="rev-label">' + row[0] + '</span><span class="rev-value" style="font-size:12px">' + row[1] + '</span></div>';
  }).join('');
  var checks = [[true,'Merchant KYC/KYB Policy Documented'],[true,'AML/CFT Policy Filed with CBN'],
    [true,'Transaction Monitoring System Active'],[true,'STR Filing Workflow Active'],
    [false,'Quarterly CBN Return (Q2 2025)'],[true,'NDPR Data Subject Request Process'],
    [true,'7-Year Data Retention Policy (BOFIA)'],[false,'Annual External Audit Submission']];
  var checkHtml = checks.map(function(row) {
    return '<div class="flex" style="margin-bottom:10px;gap:8px">' +
           '<span style="color:' + (row[0]?'var(--green)':'var(--amber)') + ';font-weight:600">' + (row[0]?'&#10003;':'&#9675;') + '</span>' +
           '<span style="font-size:13px;color:' + (row[0]?'var(--gray-700)':'var(--amber)') + '">' + row[1] + '</span></div>';
  }).join('');
  var done = checks.filter(function(c){return c[0];}).length;
  return '<div class="grid-3" style="margin-bottom:20px">' +
    '<div class="stat-card"><div class="stat-label">KYC Pending</div><div class="stat-value text-red">3</div></div>' +
    '<div class="stat-card"><div class="stat-label">AML Flags (Open)</div><div class="stat-value text-amber">1</div></div>' +
    '<div class="stat-card"><div class="stat-label">Compliance Score</div><div class="stat-value text-lime">' + done + '/' + checks.length + '</div></div></div>' +
    '<div class="grid-2"><div class="card"><div class="card-header"><div class="card-title">CBN License Details</div></div>' + licenseHtml + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Compliance Checklist</div></div>' + checkHtml + '</div></div>';
}

// ── CBN Returns ───────────────────────────────────────────────────────────
function renderCompCBNN() {
  setTimeout(loadCBNNReturn, 0);
  var d = new Date();
  var mon = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  return '<div class="grid-2" style="margin-bottom:20px">' +
    '<div class="card"><div class="card-header"><div class="card-title">Generate CBN Monthly Return</div></div>' +
    '<div class="form-group"><label class="form-label">Reporting Month</label>' +
    '<input class="form-input" type="month" id="cbnn-month" value="' + mon + '" style="width:200px"></div>' +
    '<div class="flex" style="gap:8px">' +
    '<button class="btn btn-lime" onclick="loadCBNNReturn()">&#9654; Generate</button>' +
    '<button class="btn btn-outline" onclick="downloadCBNNReturn()">&#8681; Download CSV</button>' +
    '</div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">CBN Filing Reference</div></div>' +
    '<div class="rev-row"><span class="rev-label">License</span><span class="rev-value" style="font-size:12px">CBN/PAY/2024/001847</span></div>' +
    '<div class="rev-row"><span class="rev-label">Form</span><span class="rev-value" style="font-size:12px">PSP Monthly Operations Return</span></div>' +
    '<div class="rev-row"><span class="rev-label">Due By</span><span class="rev-value" style="font-size:12px">7th of following month</span></div>' +
    '<div class="rev-row"><span class="rev-label">Submission</span><span class="rev-value" style="font-size:12px">CBN e-FASS Portal</span></div>' +
    '</div></div>' +
    '<div id="cbnn-result"><div class="info-box">Click Generate to query the database for the selected period.</div></div>';
}

async function loadCBNNReturn() {
  var el = document.getElementById('cbnn-result');
  if (!el) return;
  var m = document.getElementById('cbnn-month');
  var month = m ? m.value : '';
  el.innerHTML = '<div class="info-box">&#8987; Querying database...</div>';
  var res = await apiFetch('/compliance/cbnn-return' + (month ? '?month=' + month : ''));
  if (!res || !res.status) {
    el.innerHTML = '<div class="warn-box">&#9888; ' + (res && res.message ? res.message : 'Failed to load') + '</div>'; return;
  }
  var d = res.data; var s = d.summary;
  window.__lastCBNNData = d;
  var channelRows = Object.entries(d.by_channel || {}).map(function(e) {
    var v = e[1];
    return '<tr><td><span class="tag">' + e[0] + '</span></td><td class="mono">' + (v.success_count||0).toLocaleString() +
      '</td><td class="mono">' + (v.failed_count||0).toLocaleString() + '</td><td class="mono">&#8358;' +
      Number(v.total_volume||0).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" style="color:var(--gray-400);text-align:center;padding:14px">No transactions for this period</td></tr>';
  var merchantRows = (d.by_merchant || []).slice(0,10).map(function(m) {
    return '<tr><td class="mono" style="font-size:11px">' + m.merchantCode + '</td><td>' + m.businessName +
      '</td><td class="mono">' + (m.success_count||0).toLocaleString() + '</td><td class="mono">&#8358;' +
      Number(m.total_volume||0).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td><td class="mono text-lime">&#8358;' +
      Number(m.total_fees||0).toLocaleString(undefined,{minimumFractionDigits:2}) + '</td></tr>';
  }).join('') || '<tr><td colspan="5" style="color:var(--gray-400);text-align:center;padding:14px">No merchant data</td></tr>';
  el.innerHTML = '<div class="card" style="margin-bottom:16px"><div class="card-header">' +
    '<div><div class="card-title">Monthly Return &mdash; ' + d.period.month + '</div>' +
    '<div class="card-subtitle">Entity: ' + d.entity + ' &middot; ' + d.cbn_license + '</div></div>' +
    '<span class="badge badge-green">GENERATED</span></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card card-sm"><div class="stat-label">Total Transactions</div><div class="stat-value" style="font-size:20px">' + (s.total_transactions||0).toLocaleString() + '</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label">Total Volume</div><div class="stat-value" style="font-size:20px">&#8358;' + Number(s.total_volume_ngn||0).toLocaleString(undefined,{maximumFractionDigits:0}) + '</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label">Fees Collected</div><div class="stat-value" style="font-size:20px">&#8358;' + Number(s.total_fees_ngn||0).toLocaleString(undefined,{maximumFractionDigits:0}) + '</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label">Paylode Net</div><div class="stat-value" style="font-size:20px">&#8358;' + Number(s.paylode_net_ngn||0).toLocaleString(undefined,{maximumFractionDigits:0}) + '</div></div>' +
    '</div></div>' +
    '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">By Channel</div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Channel</th><th>Success</th><th>Failed</th><th>Volume</th></tr></thead><tbody>' + channelRows + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">By Merchant (Top 10)</div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Txns</th><th>Volume</th><th>Fees</th></tr></thead><tbody>' + merchantRows + '</tbody></table></div></div>' +
    '</div>';
}

function downloadCBNNReturn() {
  var d = window.__lastCBNNData;
  if (!d) { alert('Generate the report first.'); return; }
  var lines = [
    '"CBN MONTHLY RETURN — PAYLODE SERVICES LIMITED"',
    '"License:","' + d.cbn_license + '"',
    '"Period:","' + d.period.month + '"',
    '"Generated:","' + d.generated_at + '"',
    '','"SUMMARY"',
    '"Total Transactions",' + d.summary.total_transactions,
    '"Total Volume (NGN)",' + d.summary.total_volume_ngn,
    '"Fees Collected (NGN)",' + d.summary.total_fees_ngn,
    '"Rail Costs (NGN)",' + d.summary.total_rail_cost_ngn,
    '"Paylode Net (NGN)",' + d.summary.paylode_net_ngn,
    '','"BY CHANNEL"','"Channel","Success Txns","Failed Txns","Volume (NGN)"',
  ];
  Object.entries(d.by_channel || {}).forEach(function(e) {
    lines.push('"' + e[0] + '",' + e[1].success_count + ',' + e[1].failed_count + ',' + e[1].total_volume);
  });
  lines.push('','"BY MERCHANT"','"Code","Business Name","Success Txns","Volume (NGN)","Fees (NGN)"');
  (d.by_merchant || []).forEach(function(m) {
    lines.push('"' + m.merchantCode + '","' + m.businessName + '",' + m.success_count + ',' + m.total_volume + ',' + m.total_fees);
  });
  var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'cbnn-return-' + d.period.month + '.csv'; a.click();
}

// ── STR Filing ────────────────────────────────────────────────────────────
function renderCompSTR() {
  setTimeout(loadSTRData, 0);
  return '<div class="info-box" style="margin-bottom:16px">&#8505; Suspicious Transaction Reports must be filed with NFIU within <strong>72 hours</strong> of detecting suspicious activity (CBN AML/CFT Guidelines 2022, Section 7.3).</div>' +
    '<div class="grid-2">' +
    '<div id="str-aml-box"><div class="card"><div class="card-header"><div class="card-title">Open AML Flags</div></div><div style="padding:14px;color:var(--gray-400)">Loading...</div></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">File New STR</div></div>' +
    '<div class="form-group"><label class="form-label">Merchant ID (optional)</label><input class="form-input" id="str-mid" placeholder="UUID of merchant"></div>' +
    '<div class="form-group"><label class="form-label">Transaction References</label><input class="form-input" id="str-refs" placeholder="TXN-..., TXN-... (comma-separated)"></div>' +
    '<div class="form-group"><label class="form-label">Risk Level</label>' +
    '<select class="form-input form-select" id="str-risk"><option value="HIGH">HIGH</option><option value="CRITICAL">CRITICAL</option><option value="MEDIUM">MEDIUM</option></select></div>' +
    '<div class="form-group"><label class="form-label">Narrative *</label>' +
    '<textarea class="form-input" id="str-narrative" rows="4" placeholder="Describe the suspicious activity, patterns observed, and basis for filing..."></textarea></div>' +
    '<button class="btn btn-lime" onclick="submitSTR()">Create STR Draft</button>' +
    '<div id="str-msg" style="margin-top:8px"></div></div></div>' +
    '<div class="section-gap"><div id="str-list"><div class="info-box">Loading STR history...</div></div></div>';
}

async function loadSTRData() {
  var [flagRes, strRes] = await Promise.all([apiFetch('/compliance/aml-flags'), apiFetch('/compliance/str')]);
  var flagEl = document.getElementById('str-aml-box');
  if (flagEl) {
    var flags = (flagRes && flagRes.status) ? (flagRes.data || []) : [];
    var flagHtml = flags.map(function(f) {
      var rb = {HIGH:'badge-red',CRITICAL:'badge-red',MEDIUM:'badge-amber',LOW:'badge-gray'}[f.riskLevel]||'badge-gray';
      return '<div style="padding:10px 0;border-bottom:1px solid var(--gray-100)">' +
        '<div class="flex-between" style="margin-bottom:4px"><span style="font-size:12px;font-weight:600">' + (f.merchant?f.merchant.businessName:'—') + '</span><span class="badge ' + rb + '">' + f.riskLevel + '</span></div>' +
        '<div style="font-size:11px;color:var(--gray-500)">' + f.flagType + (f.transaction?' &middot; '+f.transaction.reference.slice(-10):'') + '</div>' +
        '<div style="font-size:11px;color:var(--gray-400)">' + new Date(f.createdAt).toLocaleDateString() + '</div></div>';
    }).join('') || '<div style="padding:14px;color:var(--gray-400);text-align:center">No open AML flags &#10003;</div>';
    flagEl.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">Open AML Flags</div><span class="badge badge-amber">' + flags.length + ' open</span></div>' + flagHtml + '</div>';
  }
  var listEl = document.getElementById('str-list');
  if (listEl) {
    var strs = (strRes && strRes.status) ? (strRes.data || []) : [];
    var rows = strs.map(function(s) {
      var sb = {draft:'badge-amber',submitted:'badge-blue',acknowledged:'badge-green'}[s.status]||'badge-gray';
      var rb = {HIGH:'badge-red',CRITICAL:'badge-red',MEDIUM:'badge-amber'}[s.riskLevel]||'badge-gray';
      var action = s.status==='draft'
        ? '<button class="btn btn-lime btn-sm" onclick="submitSTRToNFIU(\'' + s.id + '\')">Submit to NFIU</button>'
        : (s.nfiuRef ? '<span class="mono" style="font-size:11px">' + s.nfiuRef + '</span>' : '<span style="color:var(--gray-400)">Submitted</span>');
      return '<tr><td class="mono" style="font-size:11px">' + s.reference + '</td>' +
        '<td>' + (s.merchant?s.merchant.businessName:'—') + '</td>' +
        '<td><span class="badge ' + rb + '">' + s.riskLevel + '</span></td>' +
        '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">' + s.narrative + '</td>' +
        '<td><span class="badge ' + sb + '">' + s.status + '</span></td>' +
        '<td style="font-size:12px">' + new Date(s.createdAt).toLocaleDateString() + '</td>' +
        '<td>' + action + '</td></tr>';
    }).join('') || '<tr><td colspan="7" style="text-align:center;padding:14px;color:var(--gray-400)">No STR filings yet</td></tr>';
    listEl.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">STR Filing History</div><span class="badge badge-gray">' + strs.length + ' total</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Merchant</th><th>Risk</th><th>Narrative</th><th>Status</th><th>Date</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }
}

async function submitSTR() {
  var mid = document.getElementById('str-mid').value.trim();
  var refs = document.getElementById('str-refs').value.trim();
  var risk = document.getElementById('str-risk').value;
  var narrative = document.getElementById('str-narrative').value.trim();
  var msg = document.getElementById('str-msg');
  if (!narrative) { if (msg) msg.innerHTML = '<div class="warn-box">Narrative is required.</div>'; return; }
  var res = await apiFetch('/compliance/str', { method:'POST', body:JSON.stringify({ merchantId:mid||undefined, transactionRefs:refs?refs.split(',').map(function(r){return r.trim();}):[], riskLevel:risk, narrative }) });
  if (msg) msg.innerHTML = res&&res.status ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; STR draft: ' + res.data.reference + '</div>' : '<div class="warn-box">&#9888; ' + (res&&res.message||'Error') + '</div>';
  if (res&&res.status) { document.getElementById('str-narrative').value=''; loadSTRData(); }
}

async function submitSTRToNFIU(id) {
  var ref = prompt('NFIU acknowledgement reference (optional):');
  if (ref === null) return;
  var res = await apiFetch('/compliance/str/' + id + '/submit', { method:'PATCH', body:JSON.stringify({nfiuRef:ref||undefined}) });
  if (res&&res.status) { alert('STR marked as submitted to NFIU.'); loadSTRData(); }
  else alert('Error: ' + (res&&res.message||'Failed'));
}

// ── Data Retention ────────────────────────────────────────────────────────
function renderCompRetention() {
  setTimeout(loadRetentionData, 0);
  var policyRows = [['Transaction Records','7 years','BOFIA 2020 s.59'],['Customer ID / KYC','10 years post-closure','CBN AML/CFT Guidelines'],
    ['Audit Logs','7 years (immutable)','CBN Guidelines'],['Webhook Logs','3 years','Best practice'],
    ['Settlement Records','7 years','BOFIA 2020'],['Chargeback Records','7 years','CBN Dispute Rules']].map(function(r) {
    return '<div class="rev-row"><div><div class="rev-label" style="font-size:12px">' + r[0] + '</div><div style="font-size:10px;color:var(--gray-400)">' + r[2] + '</div></div><span class="rev-value" style="font-size:12px;color:var(--gray-600)">' + r[1] + '</span></div>';
  }).join('');
  return '<div class="warn-box" style="margin-bottom:16px">&#9888; <strong>BOFIA 2020, Section 59</strong> requires all transaction and customer records to be retained for a minimum of <strong>7 years</strong>. Deletion requires written CCO approval and must be audit-logged.</div>' +
    '<div id="retention-stats"><div class="info-box">Loading retention statistics...</div></div>' +
    '<div class="section-gap"><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Retention Schedule</div></div>' + policyRows + '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Disposition Controls</div></div>' +
    '<div class="info-box" style="font-size:12px;margin-bottom:16px">&#8505; Permanent deletion requires written approval from the Chief Compliance Officer and is logged to the immutable audit trail.</div>' +
    '<div class="form-group"><label class="form-label">Retention Review Cycle</label><select class="form-input form-select"><option>Annually (Recommended)</option><option>Quarterly</option></select></div>' +
    '<div class="form-group"><label class="form-label">Auto-Archive Threshold</label><select class="form-input form-select"><option>5 years (move to cold storage)</option><option>7 years</option></select></div>' +
    '<button class="btn btn-outline btn-sm" onclick="alert(\'Config saved (demo)\')">Save Config</button></div></div></div>';
}

async function loadRetentionData() {
  var el = document.getElementById('retention-stats');
  if (!el) return;
  var res = await apiFetch('/compliance/retention');
  if (!res || !res.status) { el.innerHTML = '<div class="warn-box">&#9888; Failed to load retention data.</div>'; return; }
  var d = res.data; var t = d.transactions;
  var ok = d.status === 'COMPLIANT';
  var bg = ok?'#f0fdf4':'#fffbeb'; var br = ok?'#bbf7d0':'#fde68a'; var tx = ok?'#166534':'#92400e';
  var oldest = t.oldest_record ? new Date(t.oldest_record).toLocaleDateString() : 'No records yet';
  el.innerHTML = '<div style="background:' + bg + ';border:1px solid ' + br + ';border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">' +
    '<div><div style="font-weight:700;font-size:14px;color:' + tx + '">' + (ok?'&#10003; Retention Compliant':'&#9888; Review Required — Records Exist Past 7 Years') + '</div>' +
    '<div style="font-size:12px;color:' + tx + ';margin-top:2px">' + d.policy.regulation + '</div></div>' +
    '<span class="badge ' + (ok?'badge-green':'badge-amber') + '">' + (ok?'COMPLIANT':'ACTION NEEDED') + '</span></div>' +
    '<div class="stats-grid" style="margin-bottom:16px">' +
    '<div class="stat-card card-sm"><div class="stat-label"><span class="dot" style="background:var(--green)"></span>Under 1 Year</div><div class="stat-value" style="font-size:20px">' + (t.under_1yr||0).toLocaleString() + '</div><div class="stat-sub">transactions</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label"><span class="dot" style="background:var(--blue)"></span>1 &ndash; 3 Years</div><div class="stat-value" style="font-size:20px">' + (t['1_to_3yr']||0).toLocaleString() + '</div><div class="stat-sub">transactions</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label"><span class="dot" style="background:var(--amber)"></span>3 &ndash; 7 Years</div><div class="stat-value" style="font-size:20px">' + (t['3_to_7yr']||0).toLocaleString() + '</div><div class="stat-sub">transactions</div></div>' +
    '<div class="stat-card card-sm"><div class="stat-label"><span class="dot" style="background:' + (t.over_7yr>0?'var(--red)':'var(--gray-300)') + '"></span>Over 7 Years</div><div class="stat-value" style="font-size:20px;color:' + (t.over_7yr>0?'var(--red)':'var(--gray-400)') + '">' + (t.over_7yr||0).toLocaleString() + '</div><div class="stat-sub">' + (t.over_7yr>0?'&#9888; review for disposition':'compliant') + '</div></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Record Inventory</div></div>' +
    '<div class="rev-row"><span class="rev-label">User Accounts</span><span class="rev-value">' + (d.other_records.user_accounts||0).toLocaleString() + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">KYC Submissions</span><span class="rev-value">' + (d.other_records.kyc_submissions||0).toLocaleString() + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Audit Log Entries</span><span class="rev-value">' + (d.other_records.audit_logs||0).toLocaleString() + '</span></div>' +
    '<div class="rev-row"><span class="rev-label">Oldest Transaction</span><span class="rev-value">' + oldest + '</span></div></div>';
}

// ── NDPR / Privacy ────────────────────────────────────────────────────────
function renderCompNDPR() {
  setTimeout(loadDSRData, 0);
  var oblRows = [['Response Deadline','72 hours from receipt'],['Regulator','NITDA — nitda.gov.ng'],
    ['Penalty (breach)','Up to 2% annual turnover or ₦10M'],['DPO Requirement','Mandatory for data processors'],
    ['Lawful Basis','Consent or legitimate interest'],['Privacy Policy','Published and current']].map(function(r) {
    return '<div class="rev-row"><span class="rev-label" style="font-size:12px">' + r[0] + '</span><span class="rev-value" style="font-size:12px;color:var(--gray-600)">' + r[1] + '</span></div>';
  }).join('');
  return '<div class="info-box" style="margin-bottom:16px">&#8505; Under <strong>NDPR 2019</strong>, data subjects have the right to <strong>access</strong>, <strong>correct</strong>, <strong>delete</strong>, and <strong>port</strong> their personal data. All requests must be processed within 72 hours.</div>' +
    '<div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Log Data Subject Request</div></div>' +
    '<div class="form-group"><label class="form-label">Subject Name *</label><input class="form-input" id="dsr-name" placeholder="Full name"></div>' +
    '<div class="form-group"><label class="form-label">Subject Email *</label><input class="form-input" type="email" id="dsr-email" placeholder="email@example.com"></div>' +
    '<div class="form-group"><label class="form-label">Request Type *</label>' +
    '<select class="form-input form-select" id="dsr-type">' +
    '<option value="access">Right of Access &mdash; export personal data</option>' +
    '<option value="deletion">Right to Erasure &mdash; delete personal data</option>' +
    '<option value="correction">Right to Rectification &mdash; correct inaccurate data</option>' +
    '<option value="portability">Right to Portability &mdash; structured data transfer</option>' +
    '</select></div>' +
    '<div class="form-group"><label class="form-label">Request Details *</label>' +
    '<textarea class="form-input" id="dsr-details" rows="3" placeholder="Describe what the subject is requesting..."></textarea></div>' +
    '<button class="btn btn-lime" onclick="submitDSR()">Log Request</button>' +
    '<div id="dsr-msg" style="margin-top:8px"></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">NDPR Obligations</div></div>' + oblRows + '</div></div>' +
    '<div class="section-gap"><div id="dsr-list"><div class="info-box">Loading requests...</div></div></div>';
}

async function loadDSRData() {
  var el = document.getElementById('dsr-list');
  if (!el) return;
  var res = await apiFetch('/compliance/dsr');
  var dsrs = (res && res.status) ? (res.data || []) : [];
  var pending = dsrs.filter(function(d){return d.status==='pending';}).length;
  var rows = dsrs.map(function(d) {
    var sb = {pending:'badge-amber',processing:'badge-blue',fulfilled:'badge-green',rejected:'badge-red'}[d.status]||'badge-gray';
    var tb = {access:'badge-blue',deletion:'badge-red',correction:'badge-amber',portability:'badge-purple'}[d.requestType]||'badge-gray';
    var actions = (d.status==='pending'||d.status==='processing')
      ? '<button class="btn btn-outline btn-sm" onclick="fulfillDSR(\'' + d.id + '\')">&#10003; Fulfill</button>&nbsp;<button class="btn btn-outline btn-sm" onclick="rejectDSR(\'' + d.id + '\')">Reject</button>'
      : (d.responseNotes ? '<span style="font-size:11px;color:var(--gray-400)">' + d.responseNotes.slice(0,40) + (d.responseNotes.length>40?'...':'') + '</span>' : '&mdash;');
    return '<tr><td class="mono" style="font-size:11px">' + d.reference + '</td>' +
      '<td>' + d.subjectName + '<div style="font-size:11px;color:var(--gray-400)">' + d.subjectEmail + '</div></td>' +
      '<td><span class="badge ' + tb + '">' + d.requestType + '</span></td>' +
      '<td><span class="badge ' + sb + '">' + d.status + '</span></td>' +
      '<td style="font-size:12px">' + new Date(d.createdAt).toLocaleDateString() + '</td>' +
      '<td>' + actions + '</td></tr>';
  }).join('') || '<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--gray-400)">No data subject requests yet</td></tr>';
  el.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">Data Subject Request Log</div><span class="badge badge-amber">' + pending + ' pending</span></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Subject</th><th>Type</th><th>Status</th><th>Received</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

async function submitDSR() {
  var name = document.getElementById('dsr-name').value.trim();
  var email = document.getElementById('dsr-email').value.trim();
  var type = document.getElementById('dsr-type').value;
  var details = document.getElementById('dsr-details').value.trim();
  var msg = document.getElementById('dsr-msg');
  if (!name || !email || !details) { if(msg) msg.innerHTML = '<div class="warn-box">All fields are required.</div>'; return; }
  var res = await apiFetch('/compliance/dsr', { method:'POST', body:JSON.stringify({subjectName:name, subjectEmail:email, requestType:type, details}) });
  if (msg) msg.innerHTML = res&&res.status ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Request logged: ' + res.data.reference + '</div>' : '<div class="warn-box">&#9888; ' + (res&&res.message||'Error') + '</div>';
  if (res&&res.status) { document.getElementById('dsr-name').value=''; document.getElementById('dsr-email').value=''; document.getElementById('dsr-details').value=''; loadDSRData(); }
}

async function fulfillDSR(id) {
  var notes = prompt('Response notes (optional):');
  if (notes === null) return;
  var res = await apiFetch('/compliance/dsr/' + id + '/fulfill', { method:'PATCH', body:JSON.stringify({responseNotes:notes||undefined}) });
  if (res&&res.status) loadDSRData(); else alert('Error: ' + (res&&res.message||'Failed'));
}

async function rejectDSR(id) {
  var notes = prompt('Reason for rejection:');
  if (!notes) return;
  var res = await apiFetch('/compliance/dsr/' + id + '/reject', { method:'PATCH', body:JSON.stringify({responseNotes:notes}) });
  if (res&&res.status) loadDSRData(); else alert('Error: ' + (res&&res.message||'Failed'));
}

function renderSettings() {
  var user = {};
  try { user = JSON.parse(sessionStorage.getItem('paylode_user') || '{}'); } catch(e) {}
  var isStaff = ['SUPER_ADMIN','COMPLIANCE_OFFICER','ADMIN'].indexOf(user.role) > -1;
  var tfaEnabled = user.totpEnabled;
  var tfaSection = isStaff ? (
    '<div class="section-gap"><div class="card"><div class="card-header"><div class="card-title">Two-Factor Authentication</div>' +
    '<span class="badge ' + (tfaEnabled?'badge-green':'badge-amber') + '">' + (tfaEnabled?'Enabled':'Not enabled') + '</span></div>' +
    (tfaEnabled
      ? '<div class="info-box" style="margin-bottom:16px;font-size:12px">&#10003; 2FA is active. Every login requires your authenticator code.</div>' +
        '<div class="form-grid"><div class="form-group"><label class="form-label">Current Password</label><input class="form-input" type="password" id="tfa-dis-pw"></div>' +
        '<div class="form-group"><label class="form-label">Authenticator Code</label><input class="form-input" id="tfa-dis-code" placeholder="6-digit code" maxlength="6"></div></div>' +
        '<button class="btn btn-outline" onclick="disable2FA()">Disable 2FA</button>'
      : '<div class="warn-box" style="margin-bottom:16px;font-size:12px">&#9888; 2FA is not enabled. All staff accounts must enable 2FA before go-live.</div>' +
        '<button class="btn btn-lime" onclick="setup2FA()">Set Up 2FA (Recommended)</button>'
    ) +
    '<div id="tfa-msg" style="margin-top:8px"></div></div></div>'
  ) : '';
  return '<div class="page-header"><div class="page-title">Platform Settings</div></div><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Webhook Global Settings</div></div>' +
    '<div class="form-group"><label class="form-label">Webhook Signing Secret</label><input class="form-input mono" type="password" value="whsec_paylode_xk8m2..."></div>' +
    '<div class="form-group"><label class="form-label">Retry Attempts</label><input class="form-input" type="number" value="3" style="width:80px"></div>' +
    '<div class="form-group"><label class="form-label">Retry Interval (seconds)</label><input class="form-input" type="number" value="30" style="width:80px"></div>' +
    '<button class="btn btn-primary btn-sm">Save Webhook Config</button></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Transaction Limits</div></div>' +
    '<div class="form-group"><label class="form-label">Single Transaction Cap (&#8358;)</label><input class="form-input" value="5,000,000"></div>' +
    '<div class="form-group"><label class="form-label">Daily Merchant Limit Default (&#8358;)</label><input class="form-input" value="50,000,000"></div>' +
    '<div class="form-group"><label class="form-label">USSD Transaction Limit (&#8358;)</label><input class="form-input" value="100,000"></div>' +
    '<button class="btn btn-primary btn-sm">Save Limits</button></div></div>' + tfaSection;
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
    '<div class="card"><div class="card-header"><div class="card-title">Monthly Statements</div><button class="btn btn-outline btn-sm" onclick="downloadAggRevenueCsv()">&#8681; Download All</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Period</th><th>Merchant Volume</th><th>Gross Revenue</th><th>Rail Deduction</th><th>Net Pool</th><th>Your Share (30%)</th><th>Status</th></tr></thead>' +
    '<tbody>' + tableRows + '</tbody></table></div></div>';
}
function downloadAggRevenueCsv() {
  var rows = [['Period','Merchant Volume','Gross Revenue','Rail Deduction','Net Pool','Your Share','Status'],
    ['May 2025','139000000','1980000','389000','1590000','478000','pending'],
    ['Apr 2025','114000000','1620000','318000','1300000','391000','completed'],
    ['Mar 2025','101000000','1430000','281000','1150000','344000','completed']];
  var csv = rows.map(function(r){ return r.map(function(v){ return '"'+v+'"'; }).join(','); }).join('\n');
  var blob = new Blob([csv], { type:'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'paylode-revenue-share-' + new Date().toISOString().split('T')[0] + '.csv';
  a.click();
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
  setTimeout(initMerchCharts, 0);
  return '<div class="page-header"><div class="page-title">Merchant Dashboard</div>' +
    '<div class="page-desc">Bolt Nigeria &mdash; Payment performance overview</div></div>' +
    '<div class="stats-grid">' +
    '<div class="stat-card"><div class="stat-label">Today\'s Volume</div><div class="stat-value">&#8358;12.1M</div><div class="stat-sub"><span class="stat-change up">&#8593; 8.2%</span> vs yesterday</div></div>' +
    '<div class="stat-card"><div class="stat-label">Success Rate</div><div class="stat-value">98.6%</div><div class="stat-sub"><span class="stat-change up">&#8593; 0.3%</span> vs last week</div></div>' +
    '<div class="stat-card"><div class="stat-label">Settled Today</div><div class="stat-value">&#8358;11.8M</div><div class="stat-sub">T+1 settlement</div></div>' +
    '<div class="stat-card"><div class="stat-label">Processing Rate</div><div class="stat-value text-lime">1.2%</div><div class="stat-sub">Growth tier rate</div></div></div>' +
    '<div class="section-gap"><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div><div class="card-title">Daily Volume (7 Days)</div><div class="card-subtitle">Transaction volume in &#8358;M</div></div></div>' +
    '<div style="position:relative;height:200px"><canvas id="merch-vol-chart"></canvas></div></div>' +
    '<div class="card"><div class="card-header"><div><div class="card-title">Payment Channels</div><div class="card-subtitle">Today\'s split by method</div></div></div>' +
    '<div style="position:relative;height:200px"><canvas id="merch-channel-chart"></canvas></div></div>' +
    '</div></div>' +
    '<div class="section-gap"><div class="grid-2">' +
    '<div class="card"><div class="card-header"><div class="card-title">Recent Transactions</div>' +
    '<button class="btn btn-outline btn-sm" onclick="navigate(\'merch_transactions\')">View All</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Amount</th><th>Channel</th><th>Status</th></tr></thead>' +
    '<tbody>' + txRows + '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Fee Breakdown (Today)</div></div>' +
    '<div class="rev-row"><span class="rev-label">Total Collections</span><span class="rev-value">&#8358;12,100,000</span></div>' +
    '<div class="rev-row"><span class="rev-label">Processing Fees (1.2%)</span><span class="rev-value text-red">&#8358;145,200</span></div>' +
    '<div class="rev-net"><span style="font-weight:700;font-size:13px;color:#166534">Your Net Settlement</span><span style="font-weight:800;font-size:18px;color:#166534">&#8358;11,954,800</span></div>' +
    '<div class="divider"></div><div style="font-size:12px;color:var(--gray-400)">Settlement disbursed by 9AM next business day to GTBank ****1234</div>' +
    '</div></div></div>';
}

function initMerchCharts() {
  if (typeof Chart === 'undefined') return;
  var ctx1 = document.getElementById('merch-vol-chart');
  if (ctx1) {
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Today'],
        datasets: [{
          label: 'Volume (₦M)',
          data: [8.2, 11.4, 9.8, 13.1, 10.7, 6.4, 12.1],
          backgroundColor: 'rgba(125,197,52,0.75)',
          borderColor: '#5fa01f',
          borderWidth: 1,
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, border: { display: false }, grid: { color: 'rgba(0,0,0,0.05)' },
               ticks: { font: { size: 11 }, color: '#64748b', callback: function(v) { return '₦' + v + 'M'; } } },
          x: { grid: { display: false }, border: { display: false },
               ticks: { font: { size: 11 }, color: '#64748b' } }
        }
      }
    });
  }
  var ctx2 = document.getElementById('merch-channel-chart');
  if (ctx2) {
    new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['Card', 'Bank Transfer', 'USSD'],
        datasets: [{
          data: [58, 29, 13],
          backgroundColor: ['#3b82f6', '#7dc534', '#f59e0b'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 14, usePointStyle: true, color: '#475569' } }
        },
        cutout: '68%'
      }
    });
  }
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
  var d = new Date();
  var mon = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  var rows = [['26 May 2025','25 May','&#8358;11,200,000','&#8358;134,400','&#8358;11,065,600','GTB ****1234','pending'],
    ['25 May 2025','24 May','&#8358;9,800,000','&#8358;117,600','&#8358;9,682,400','GTB ****1234','completed'],
    ['24 May 2025','23 May','&#8358;12,400,000','&#8358;148,800','&#8358;12,251,200','GTB ****1234','completed']].map(function(r) {
    return '<tr>' + r.map(function(v,i){ return '<td class="' + (i>=2&&i<=4?'mono':'') + '">' + (i===6?statusBadge(v):v) + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="page-header flex-between"><div><div class="page-title">Settlements</div></div></div>' +
    '<div class="card" style="margin-bottom:16px"><div class="card-header"><div class="card-title">Monthly Statement</div></div>' +
    '<div class="flex" style="gap:10px;align-items:center;flex-wrap:wrap">' +
    '<input class="form-input" type="month" id="stmt-month" value="' + mon + '" style="width:180px">' +
    '<button class="btn btn-lime btn-sm" onclick="downloadStatement()">&#8681; Download PDF</button>' +
    '<button class="btn btn-outline btn-sm" onclick="emailStatement()">&#9993; Email to Me</button>' +
    '</div><div class="form-hint" style="margin-top:8px">Statement is generated from live transaction data for the selected month.</div></div>' +
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
  return '<div class="page-header"><div class="page-title">Card Payments API</div>' +
    '<div class="page-desc">Local (NGN) and International (USD) card charges</div></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px"><strong>Currency drives the product.</strong> Pass <span class="mono">currency:"NGN"</span> for local cards (charged in kobo) or <span class="mono">currency:"USD"</span> for international cards (charged in cents). International card transactions are billed, settled and reported entirely in <strong>USD</strong>, separate from your Naira balance.</div>' +
    '<div class="card" style="margin-bottom:12px">' +
    '<div class="flex-between" style="margin-bottom:12px"><div><span class="badge badge-green" style="font-size:12px">POST</span> ' +
    '<span class="mono" style="font-size:13px">/v1/transaction/initialize</span></div><span class="badge badge-amber">Requires Secret Key</span></div>' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700);margin-bottom:6px">Local card (NGN) — amount in kobo</div>' +
    '<div class="code-block">{\n  <span class="str">"email"</span>: <span class="str">"customer@example.com"</span>,\n  <span class="str">"amount"</span>: <span class="num">5000000</span>,        <span class="comment">// ₦50,000 in kobo</span>\n  <span class="str">"currency"</span>: <span class="str">"NGN"</span>,\n  <span class="str">"reference"</span>: <span class="str">"TXN-001"</span>,\n  <span class="str">"channels"</span>: [<span class="str">"card"</span>]\n}</div>' +
    '<div style="font-size:12px;font-weight:700;color:#1e40af;margin:14px 0 6px">🌍 International card (USD) — amount in cents</div>' +
    '<div class="code-block">{\n  <span class="str">"email"</span>: <span class="str">"customer@example.com"</span>,\n  <span class="str">"amount"</span>: <span class="num">50000</span>,          <span class="comment">// $500.00 in cents</span>\n  <span class="str">"currency"</span>: <span class="str">"USD"</span>,         <span class="comment">// → routed as International Card (CARD_INTL)</span>\n  <span class="str">"reference"</span>: <span class="str">"TXN-INTL-001"</span>,\n  <span class="str">"channels"</span>: [<span class="str">"card"</span>],\n  <span class="str">"card_scheme"</span>: <span class="str">"VISA"</span>,    <span class="comment">// optional: VISA|MASTERCARD|AMEX|DINERS</span>\n  <span class="str">"card_bin"</span>: <span class="str">"401288"</span>       <span class="comment">// optional: scheme auto-detected from BIN if card_scheme omitted</span>\n}</div>' +
    '<div class="info-box" style="font-size:12px;margin-top:8px">If you pass <span class="mono">card_scheme</span> (or <span class="mono">card_bin</span>), Paylode applies that scheme\'s rate when the admin has configured one — otherwise the flat International Card rate applies. Visa, Mastercard, Amex and Diners can each carry a different rate.</div>' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700);margin:14px 0 6px">Success Response (201)</div>' +
    '<div class="code-block">{\n  <span class="str">"status"</span>: <span class="kw">true</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"authorization_url"</span>: <span class="str">"https://checkout.paylodeservices.com/pay/..."</span>,\n    <span class="str">"reference"</span>: <span class="str">"TXN-INTL-001"</span>,\n    <span class="str">"currency"</span>: <span class="str">"USD"</span>,\n    <span class="str">"product"</span>: <span class="str">"CARD_INTL"</span>,\n    <span class="str">"is_international"</span>: <span class="kw">true</span>,\n    <span class="str">"fee_preview"</span>: { <span class="str">"display"</span>: <span class="str">"$17.50"</span>, <span class="str">"currency"</span>: <span class="str">"USD"</span> }\n  }\n}</div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Currency rules</div></div>' +
    '<div class="rev-row"><span class="rev-label">NGN amounts</span><span class="rev-value">in kobo (₦1 = 100)</span></div>' +
    '<div class="rev-row"><span class="rev-label">USD amounts</span><span class="rev-value">in cents ($1 = 100)</span></div>' +
    '<div class="rev-row"><span class="rev-label">Local card rate</span><span class="rev-value">CARD_LOCAL (default 1.5%)</span></div>' +
    '<div class="rev-row"><span class="rev-label">International card rate</span><span class="rev-value">CARD_INTL (default 3.5%)</span></div>' +
    '<div class="rev-row"><span class="rev-label">USD settlement</span><span class="rev-value">separate USD settlement batch</span></div>' +
    '</div>';
}

function renderSdkVerify() {
  return '<div class="page-header"><div class="page-title">Verify Payment</div></div>' +
    '<div class="warn-box" style="margin-bottom:16px">&#9888; Always verify server-side before fulfilling orders.</div>' +
    '<div class="card"><div class="flex-between" style="margin-bottom:12px">' +
    '<span class="badge badge-blue" style="font-size:12px">GET</span> ' +
    '<span class="mono" style="font-size:13px">/v1/transaction/verify/:reference</span></div>' +
    '<div class="code-block">app.<span class="fn">post</span>(<span class="str">\'/callback\'</span>, <span class="kw">async</span> (req, res) =&gt; {\n  <span class="kw">const</span> txn = <span class="kw">await</span> client.transaction.<span class="fn">verify</span>(req.body.reference);\n  <span class="kw">if</span> (txn.data.status === <span class="str">\'success\'</span>) {\n    <span class="kw">await</span> <span class="fn">fulfillOrder</span>(txn.data.metadata.order_id);\n    res.<span class="fn">json</span>({ ok: <span class="kw">true</span> });\n  }\n});</div></div>';
}

function renderSdkVirtualAccounts() {
  return '<div class="page-header"><div class="page-title">Virtual Accounts API</div>' +
    '<div class="page-desc">Accept bank transfers by assigning dedicated virtual accounts to customers</div></div>' +

    '<div class="info-box" style="margin-bottom:16px">Virtual accounts allow customers to pay via bank transfer. Each transaction generates a unique Paylode reference you can verify server-side.</div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header">' +
    '<div><div class="card-title"><span class="badge badge-green" style="margin-right:8px">POST</span>/v1/transaction/initialize</div>' +
    '<div class="card-subtitle">Initialize a transaction with bank_transfer channel to get a virtual account</div></div>' +
    '<span class="badge badge-amber">Requires Secret Key</span></div>' +
    '<div class="code-block"><span class="comment">// Request — specify bank_transfer as the channel</span>\n{\n  <span class="str">"email"</span>: <span class="str">"customer@example.com"</span>,\n  <span class="str">"amount"</span>: <span class="num">2500000</span>,        <span class="comment">// ₦25,000 in kobo</span>\n  <span class="str">"currency"</span>: <span class="str">"NGN"</span>,\n  <span class="str">"reference"</span>: <span class="str">"ORDER-001"</span>,\n  <span class="str">"channels"</span>: [<span class="str">"bank_transfer"</span>],\n  <span class="str">"metadata"</span>: { <span class="str">"order_id"</span>: <span class="str">"001"</span>, <span class="str">"customer_name"</span>: <span class="str">"Ada Okafor"</span> }\n}</div>' +
    '<div class="code-block" style="margin-top:8px"><span class="comment">// Response — includes virtual account details</span>\n{\n  <span class="str">"status"</span>: <span class="kw">true</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"reference"</span>: <span class="str">"ORDER-001"</span>,\n    <span class="str">"payment_method"</span>: <span class="str">"bank_transfer"</span>,\n    <span class="str">"virtual_account"</span>: {\n      <span class="str">"bank_name"</span>: <span class="str">"Wema Bank"</span>,\n      <span class="str">"account_number"</span>: <span class="str">"0123456789"</span>,\n      <span class="str">"account_name"</span>: <span class="str">"PAYLODE/ORDER-001"</span>,\n      <span class="str">"expires_at"</span>: <span class="str">"2026-06-12T22:00:00Z"</span>\n    },\n    <span class="str">"amount"</span>: <span class="num">2500000</span>,\n    <span class="str">"status"</span>: <span class="str">"pending"</span>\n  }\n}</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header"><div class="card-title">Fee Structure for Virtual Accounts</div></div>' +
    '<div class="info-box" style="margin-bottom:12px;font-size:12px">Virtual account fees are charged when the transfer is <strong>received</strong>, not when the account is created. The default is a <strong>flat fee</strong> per transfer received.</div>' +
    '<div class="rev-row"><span class="rev-label">Fee Model</span><span class="rev-value">Flat fee per transfer received</span></div>' +
    '<div class="rev-row"><span class="rev-label">Default Fee</span><span class="rev-value">₦50 per transfer</span></div>' +
    '<div class="rev-row"><span class="rev-label">VAT</span><span class="rev-value">7.5% of fee (₦3.75)</span></div>' +
    '<div class="rev-row"><span class="rev-label">Total per transfer</span><span class="rev-value"><strong>₦53.75</strong></span></div>' +
    '<div class="warn-box" style="margin-top:12px;font-size:12px">Merchant-specific rates can override the flat fee with a % rate. Contact support to configure.</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header"><div class="card-title">Webhook — Payment Notification</div></div>' +
    '<div class="code-block"><span class="comment">// Paylode sends this to your webhook URL when transfer is confirmed</span>\n{\n  <span class="str">"event"</span>: <span class="str">"payment.success"</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"reference"</span>: <span class="str">"ORDER-001"</span>,\n    <span class="str">"amount"</span>: <span class="num">2500000</span>,\n    <span class="str">"channel"</span>: <span class="str">"BANK_TRANSFER"</span>,\n    <span class="str">"status"</span>: <span class="str">"SUCCESS"</span>,\n    <span class="str">"paid_at"</span>: <span class="str">"2026-06-12T14:30:00Z"</span>,\n    <span class="str">"sender_name"</span>: <span class="str">"Ada Okafor"</span>,\n    <span class="str">"sender_bank"</span>: <span class="str">"GTBank"</span>\n  }\n}</div>' +
    '<div class="info-box" style="margin-top:12px;font-size:12px">Always verify the payment server-side using GET /v1/transaction/verify/:reference before fulfilling the order.</div></div>' +

    '<div class="card"><div class="card-header"><div class="card-title">Sandbox Testing</div></div>' +
    '<div class="rev-row"><span class="rev-label">Test key prefix</span><span class="rev-value mono">sk_test_...</span></div>' +
    '<div class="rev-row"><span class="rev-label">Simulate transfer</span><span class="rev-value">POST /v1/sandbox/transfer-confirm with reference</span></div>' +
    '<div class="rev-row"><span class="rev-label">Auto-confirm delay</span><span class="rev-value">Sandbox transfers confirm instantly</span></div>' +
    '<div class="code-block" style="margin-top:12px"><span class="comment">// Trigger a simulated bank transfer confirmation (sandbox only)</span>\n<span class="kw">const</span> res = <span class="kw">await</span> fetch(<span class="str">\'/api/v1/sandbox/confirm-transfer\'</span>, {\n  method: <span class="str">\'POST\'</span>,\n  headers: { <span class="str">\'Authorization\'</span>: <span class="str">\'Bearer sk_test_...\'</span>, <span class="str">\'Content-Type\'</span>: <span class="str">\'application/json\'</span> },\n  body: JSON.stringify({ reference: <span class="str">\'ORDER-001\'</span> })\n});</div></div>';
}

function renderSdkPayouts() {
  return '<div class="page-header"><div class="page-title">Payouts API</div>' +
    '<div class="page-desc">Send money to your customers and beneficiaries programmatically</div></div>' +
    '<div class="warn-box" style="margin-bottom:16px">&#9888; <strong>Wallet must be funded first.</strong> Contact Paylode support to fund your payout wallet before making payout calls. Use <span class="mono">GET /v1/payouts/wallet</span> to check your balance.</div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header"><div><div class="card-title">Authentication</div><div class="card-subtitle">Use your Secret Key — same as for payment initiation</div></div></div>' +
    '<div class="code-block"><span class="comment">// Use your Secret Key in the Authorization header</span>\n<span class="str">"Authorization: Bearer sk_live_your_secret_key"</span></div>' +
    '<div class="info-box" style="margin-top:12px;font-size:12px">Both <strong>sk_live_</strong> (production) and <strong>sk_test_</strong> (sandbox) keys are supported. Sandbox payouts are simulated and do not move real funds.</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header">' +
    '<div><div class="card-title"><span class="badge badge-blue" style="margin-right:8px">GET</span>/v1/payouts/wallet</div><div class="card-subtitle">Check your wallet balance before initiating payouts</div></div></div>' +
    '<div class="code-block"><span class="comment">// Response</span>\n{\n  <span class="str">"status"</span>: <span class="kw">true</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"balance"</span>: <span class="num">5000000</span>,           <span class="comment">// kobo</span>\n    <span class="str">"balance_naira"</span>: <span class="num">50000</span>,        <span class="comment">// ₦50,000</span>\n    <span class="str">"last_funded_at"</span>: <span class="str">"2026-06-12"</span>\n  }\n}</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header">' +
    '<div><div class="card-title"><span class="badge badge-green" style="margin-right:8px">POST</span>/v1/payouts/batches</div><div class="card-subtitle">Create a payout batch — single or bulk beneficiaries</div></div>' +
    '<span class="badge badge-amber">Requires Secret Key</span></div>' +
    '<div class="code-block"><span class="comment">// Request body</span>\n{\n  <span class="str">"description"</span>: <span class="str">"May salary payments"</span>,\n  <span class="str">"scheduled_at"</span>: <span class="str">"2026-06-15T09:00:00Z"</span>,  <span class="comment">// optional, omit for instant</span>\n  <span class="str">"items"</span>: [\n    {\n      <span class="str">"account_number"</span>: <span class="str">"0123456789"</span>,\n      <span class="str">"bank_code"</span>: <span class="str">"000013"</span>,        <span class="comment">// GTBank (NIBSS code) — OR send "bank_name"</span>\n      <span class="str">"amount"</span>: <span class="num">500000</span>,             <span class="comment">// ₦5,000 in kobo</span>\n      <span class="str">"narration"</span>: <span class="str">"May salary"</span>,       <span class="comment">// optional — see default below</span>\n      <span class="str">"account_name"</span>: <span class="str">"John Doe"</span>    <span class="comment">// optional</span>\n    }\n  ]\n}</div>' +
    '<div class="info-box" style="margin-top:8px;font-size:12px"><strong>Bank identifier:</strong> send <span class="mono">bank_code</span> (6-digit NIBSS, from <span class="mono">GET /v1/payouts/banks</span>) <em>or</em> a human <span class="mono">bank_name</span> (e.g. <span class="mono">"GTBank"</span>, <span class="mono">"OPay"</span>) and we resolve it. Amounts are always in <strong>kobo</strong> over the API. Unknown banks are rejected with <span class="mono">BANK_UNRESOLVED</span>.</div>' +
    '<div class="info-box" style="margin-top:8px;font-size:12px"><strong>Narration:</strong> every payout carries a narration. If you omit it (or send it blank), Paylode defaults to <span class="mono">"Payment from &lt;your business name&gt;"</span> so the beneficiary always sees a meaningful reference on their statement.</div>' +
    '<div class="code-block" style="margin-top:8px"><span class="comment">// Response (201)</span>\n{\n  <span class="str">"status"</span>: <span class="kw">true</span>,\n  <span class="str">"data"</span>: {\n    <span class="str">"batch_id"</span>: <span class="str">"uuid"</span>,\n    <span class="str">"batch_ref"</span>: <span class="str">"PAY-LX4F-A1B2"</span>,\n    <span class="str">"total_amount"</span>: <span class="num">5000</span>,           <span class="comment">// naira</span>\n    <span class="str">"total_items"</span>: <span class="num">1</span>,\n    <span class="str">"status"</span>: <span class="str">"processing"</span>,        <span class="comment">// or "scheduled"</span>\n    <span class="str">"wallet_balance_after"</span>: <span class="num">45000</span>  <span class="comment">// naira remaining</span>\n  }\n}</div>' +
    '<div class="info-box" style="margin-top:12px;font-size:12px">Funds are <strong>reserved immediately</strong> when the batch is created. If the payout fails, funds are returned to your wallet.</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header"><div class="card-title"><span class="badge badge-blue" style="margin-right:8px">GET</span>/v1/payouts/batches/:id</div></div>' +
    '<div class="code-block"><span class="comment">// Response</span>\n{\n  <span class="str">"data"</span>: {\n    <span class="str">"batch"</span>: { <span class="str">"batch_ref"</span>: <span class="str">"PAY-LX4F-A1B2"</span>, <span class="str">"status"</span>: <span class="str">"completed"</span>, ... },\n    <span class="str">"items"</span>: [\n      { <span class="str">"account_number"</span>: <span class="str">"0123456789"</span>, <span class="str">"status"</span>: <span class="str">"success"</span>, ... }\n    ]\n  }\n}</div></div>' +

    '<div class="card" style="margin-bottom:12px"><div class="card-header"><div><div class="card-title">Bulk payouts via file (no coding)</div><div class="card-subtitle">For non-developer merchants — upload Excel/CSV on the Payouts page</div></div></div>' +
    '<p style="font-size:13px;color:var(--gray-500);margin:4px 0 10px">The uploaded file needs just three columns (a fourth is optional). You do <strong>not</strong> supply bank codes — Paylode matches the bank by name and verifies each account before any money moves.</p>' +
    '<div class="table-wrap"><table><thead><tr><th>Column</th><th>Required</th><th>Format</th><th>Example</th></tr></thead><tbody>' +
    '<tr><td class="mono">Bank Name</td><td>Yes</td><td>Pick from the template dropdown / Bank List</td><td>OPay</td></tr>' +
    '<tr><td class="mono">Account Number</td><td>Yes</td><td>10-digit NUBAN (keep leading zeros)</td><td>7030000266</td></tr>' +
    '<tr><td class="mono">Amount</td><td>Yes</td><td>Naira (no commas, no ₦)</td><td>200</td></tr>' +
    '<tr><td class="mono">Narration</td><td>Optional</td><td>Free text reference. If left blank, defaults to &ldquo;Payment from &lt;your business name&gt;&rdquo;</td><td>Salary June</td></tr>' +
    '</tbody></table></div>' +
    '<div class="info-box" style="margin-top:10px;font-size:12px">In the file, <strong>Amount is in Naira</strong> (e.g. <span class="mono">200</span>). Over the API it is in <strong>kobo</strong> (e.g. <span class="mono">20000</span>). Accepted file types: <span class="mono">.xlsx</span> and <span class="mono">.csv</span>, up to 1,000 beneficiaries / 5 MB. ' +
    '<button class="btn btn-outline btn-sm" style="margin-left:6px" onclick="downloadPayoutTemplate && downloadPayoutTemplate()">&#8681; Download Template</button></div></div>' +

    '<div class="card"><div class="card-header"><div class="card-title">Common Bank Codes (NIBSS)</div></div>' +
    '<div class="table-wrap"><table>' +
    '<thead><tr><th>Bank</th><th>Code</th><th>Bank</th><th>Code</th></tr></thead>' +
    '<tbody>' +
    [['Zenith Bank','000015'],['GTBank','000013'],['Access Bank','000014'],['UBA','000004'],['First Bank Of Nigeria','000016'],['Fidelity Bank','000007'],['Sterling Bank','000001'],['Stanbic IBTC','000012'],['Union Bank','000018'],['Ecobank Nigeria','000010'],['Keystone Bank','000002'],['Wema Bank','000017'],['OPay','100004'],['Moniepoint','090405'],['Kuda MFB','090267'],['PalmPay','100033']].reduce(function(acc,item,i) {
      if (i%2===0) acc.push([item]);
      else acc[acc.length-1].push(item);
      return acc;
    },[]).map(function(pair) {
      return '<tr><td>' + pair[0][0] + '</td><td class="mono">' + pair[0][1] + '</td>' +
        (pair[1] ? '<td>' + pair[1][0] + '</td><td class="mono">' + pair[1][1] + '</td>' : '<td></td><td></td>') + '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="info-box" style="margin-top:12px;font-size:12px">These are 6-digit <strong>NIBSS</strong> codes. Get the full live list (816 banks) via <span class="mono">GET /v1/payouts/banks</span>, or just send the <span class="mono">bank_name</span> and let Paylode resolve it.</div></div>';
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
  return '<div class="page-header"><div class="page-title">Published SDKs</div>' +
    '<div class="page-desc">Official Paylode server-side libraries — available on npm, PyPI, and Packagist.</div></div>' +
    '<div class="grid-3" style="margin-bottom:24px">' +

    '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
    '<div style="width:38px;height:38px;background:#026e00;border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:13px">JS</div>' +
    '<div><div style="font-weight:700;font-size:14px">Node.js SDK</div>' +
    '<div style="font-size:11px;color:var(--gray-400)">npm install paylode-node</div></div></div>' +
    '<div class="code-block" style="font-size:11px">' +
    '<span class="kw">const</span> Paylode = <span class="fn">require</span>(<span class="str">\'paylode-node\'</span>);\n' +
    '<span class="kw">const</span> client = <span class="kw">new</span> <span class="fn">Paylode</span>(<span class="str">\'sk_live_...\'</span>);\n\n' +
    '<span class="comment">// Initialize transaction</span>\n' +
    '<span class="kw">const</span> txn = <span class="kw">await</span> client.transaction.<span class="fn">initialize</span>({\n' +
    '  email: <span class="str">\'user@example.com\'</span>,\n' +
    '  amount: <span class="num">5000000</span>, <span class="comment">// kobo</span>\n' +
    '  reference: <span class="str">\'TXN-\'</span> + Date.<span class="fn">now</span>()\n' +
    '});\n\n' +
    '<span class="comment">// Verify payment</span>\n' +
    '<span class="kw">const</span> result = <span class="kw">await</span> client.transaction.<span class="fn">verify</span>(ref);</div></div>' +

    '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
    '<div style="width:38px;height:38px;background:#3776ab;border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:13px">PY</div>' +
    '<div><div style="font-weight:700;font-size:14px">Python SDK</div>' +
    '<div style="font-size:11px;color:var(--gray-400)">pip install paylode-python</div></div></div>' +
    '<div class="code-block" style="font-size:11px">' +
    '<span class="kw">import</span> paylode\nclient = paylode.<span class="fn">Paylode</span>(<span class="str">\'sk_live_...\'</span>)\n\n' +
    '<span class="comment"># Initialize transaction</span>\n' +
    'txn = client.transaction.<span class="fn">initialize</span>(\n' +
    '  email=<span class="str">\'user@example.com\'</span>,\n' +
    '  amount=<span class="num">5000000</span>,\n' +
    '  reference=<span class="fn">generate_ref</span>()\n' +
    ')\n\n' +
    '<span class="comment"># Verify payment</span>\n' +
    'result = client.transaction.<span class="fn">verify</span>(reference)</div></div>' +

    '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
    '<div style="width:38px;height:38px;background:#777bb4;border-radius:8px;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:13px">PHP</div>' +
    '<div><div style="font-weight:700;font-size:14px">PHP SDK</div>' +
    '<div style="font-size:11px;color:var(--gray-400)">composer require paylode/paylode-php</div></div></div>' +
    '<div class="code-block" style="font-size:11px">' +
    '<span class="kw">use</span> Paylode\\Paylode;\n$client = <span class="kw">new</span> <span class="fn">Paylode</span>(<span class="str">\'sk_live_...\'</span>);\n\n' +
    '<span class="comment">// Initialize transaction</span>\n' +
    '$txn = $client->transaction-><span class="fn">initialize</span>([\n' +
    '  <span class="str">\'email\'</span> => <span class="str">\'user@example.com\'</span>,\n' +
    '  <span class="str">\'amount\'</span> => <span class="num">5000000</span>\n' +
    ']);\n\n' +
    '<span class="comment">// Verify payment</span>\n' +
    '$result = $client->transaction-><span class="fn">verify</span>($reference);</div></div>' +

    '</div>' +
    '<div class="card"><div class="card-header"><div class="card-title">Package Registries</div></div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">' +
    '<div style="padding:14px;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;text-align:center">' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700)">paylode-node</div>' +
    '<div style="font-size:11px;color:var(--gray-400);margin-top:2px">npmjs.com</div></div>' +
    '<div style="padding:14px;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;text-align:center">' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700)">paylode-python</div>' +
    '<div style="font-size:11px;color:var(--gray-400);margin-top:2px">pypi.org</div></div>' +
    '<div style="padding:14px;background:var(--gray-50);border:1px solid var(--gray-200);border-radius:8px;text-align:center">' +
    '<div style="font-size:12px;font-weight:700;color:var(--gray-700)">paylode/paylode-php</div>' +
    '<div style="font-size:11px;color:var(--gray-400);margin-top:2px">packagist.org</div></div>' +
    '</div></div>';
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

// ── Email Templates page ──────────────────────────────────────────────────
function renderEmailTemplates() {
  setTimeout(loadEmailTemplates, 0);
  return '<div class="page-header flex-between"><div><div class="page-title">Email Templates</div>' +
    '<div class="page-desc">Branded email templates used for KYC notifications, activations, and statements. Changes apply immediately to all outgoing emails.</div></div>' +
    '<button class="btn btn-lime" onclick="showNewTplModal()">+ New Template</button></div>' +
    '<div class="grid-2"><div id="tpl-list"><div class="info-box">Loading templates...</div></div>' +
    '<div id="tpl-editor" style="display:none"></div></div>';
}

async function loadEmailTemplates() {
  var el = document.getElementById('tpl-list');
  if (!el) return;
  var res = await apiFetch('/admin/email-templates');
  var tpls = (res && res.status) ? res.data : [];
  var html = tpls.map(function(t) {
    return '<div class="rev-row"><div><div style="font-weight:600;font-size:13px">' + t.name + (t.isSystem ? ' <span class="badge badge-gray" style="font-size:10px">system</span>' : '') + '</div>' +
      '<div class="mono" style="font-size:10px;color:var(--gray-400);margin-top:2px">' + t.slug + '</div>' +
      '<div style="font-size:11px;color:var(--gray-500);margin-top:2px">' + t.subject + '</div></div>' +
      '<div class="flex" style="gap:6px">' +
      '<span class="badge ' + (t.isActive?'badge-green':'badge-gray') + '">' + (t.isActive?'Active':'Off') + '</span>' +
      '<button class="btn btn-outline btn-sm" onclick="editTpl(\'' + t.id + '\')">Edit</button>' +
      (!t.isSystem ? '<button class="btn btn-outline btn-sm" onclick="deleteTpl(\'' + t.id + '\',\'' + t.name.replace(/'/g,"\\'") + '\')">Del</button>' : '') +
      '</div></div>';
  }).join('') || '<div style="padding:16px;color:var(--gray-400);text-align:center">No templates yet.</div>';
  el.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">All Templates</div><span class="badge badge-gray">' + tpls.length + '</span></div>' + html + '</div>';
}

async function editTpl(id) {
  var res = await apiFetch('/admin/email-templates/' + id);
  if (!res||!res.status) return;
  var t = res.data;
  var el = document.getElementById('tpl-editor');
  if (!el) return;
  el.style.display = 'block';
  var vars = Array.isArray(t.variables) ? t.variables : [];
  el.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">Editing: ' + t.name + '</div>' +
    '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'tpl-editor\').style.display=\'none\'">Close</button></div>' +
    (t.isSystem ? '<div class="info-box" style="font-size:12px;margin-bottom:12px">&#8505; System template — slug is read-only.</div>' : '') +
    '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="te-name" value="' + t.name.replace(/"/g,'&quot;') + '"></div>' +
    '<div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="te-subj" value="' + t.subject.replace(/"/g,'&quot;') + '"></div>' +
    '<div class="form-group"><label class="form-label">Variables</label>' +
    '<div style="display:flex;flex-wrap:wrap;gap:4px">' + vars.map(function(v){return '<span class="tag" style="cursor:pointer" onclick="insertVar(\'{{'+v+'}}\')">{{'+v+'}}</span>';}).join('') + '</div>' +
    '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">Click a variable to insert at cursor</div></div>' +
    '<div class="form-group"><label class="form-label">HTML Body</label>' +
    '<textarea class="form-input" id="te-body" rows="14" style="font-family:var(--mono);font-size:11px;line-height:1.6" oninput="updateTplPreview()">' + t.htmlBody.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</textarea></div>' +
    '<div class="form-group"><label class="form-label">Preview</label>' +
    '<iframe id="te-preview" style="width:100%;height:320px;border:1px solid var(--gray-200);border-radius:8px;background:#fff"></iframe></div>' +
    '<div class="flex-between"><div class="flex" style="gap:8px">' +
    '<button class="btn btn-lime" onclick="saveTpl(\'' + t.id + '\')">Save</button>' +
    '<button class="btn btn-outline" onclick="previewTpl(\'' + t.id + '\')">&#9993; Test Email</button></div>' +
    '<label class="flex" style="gap:6px;cursor:pointer"><input type="checkbox" id="te-active" ' + (t.isActive?'checked':'') + '> <span style="font-size:12px">Active</span></label></div>' +
    '<div id="te-msg" style="margin-top:8px"></div>';
  updateTplPreview();
}

function insertVar(v) {
  var ta = document.getElementById('te-body');
  if (!ta) return;
  var s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0,s) + v + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + v.length;
  ta.focus(); updateTplPreview();
}

function updateTplPreview() {
  var body = document.getElementById('te-body');
  var frame = document.getElementById('te-preview');
  if (!body||!frame) return;
  frame.srcdoc = body.value;
}

async function saveTpl(id) {
  var msg = document.getElementById('te-msg');
  var res = await apiFetch('/admin/email-templates/' + id, { method:'PATCH', body:JSON.stringify({
    name: document.getElementById('te-name').value.trim(),
    subject: document.getElementById('te-subj').value.trim(),
    htmlBody: document.getElementById('te-body').value,
    isActive: document.getElementById('te-active').checked,
  })});
  if (msg) msg.innerHTML = res&&res.status
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Saved.</div>'
    : '<div class="warn-box">&#9888; ' + (res&&res.message||'Error') + '</div>';
  if (res&&res.status) loadEmailTemplates();
}

async function previewTpl(id) {
  var to = prompt('Send preview to email address:');
  if (!to) return;
  var res = await apiFetch('/admin/email-templates/' + id + '/preview', { method:'POST', body:JSON.stringify({to}) });
  alert(res&&res.status ? 'Preview sent to ' + to : 'Error: ' + (res&&res.message||'Failed'));
}

async function deleteTpl(id, name) {
  if (!confirm('Delete template "' + name + '"?')) return;
  var res = await apiFetch('/admin/email-templates/' + id, { method:'DELETE' });
  if (res&&res.status) { loadEmailTemplates(); document.getElementById('tpl-editor').style.display='none'; }
  else alert(res&&res.message||'Error');
}

function showNewTplModal() {
  showModal('<div class="modal-header"><div class="modal-title">New Email Template</div><button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="form-group"><label class="form-label">Name *</label><input class="form-input" id="nt-name" placeholder="e.g. Welcome Email"></div>' +
    '<div class="form-group"><label class="form-label">Slug * (unique key)</label><input class="form-input" id="nt-slug" placeholder="e.g. welcome_email"></div>' +
    '<div class="form-group"><label class="form-label">Subject *</label><input class="form-input" id="nt-subj" placeholder="e.g. Welcome to Paylode, {{merchant_name}}!"></div>' +
    '<div class="form-group"><label class="form-label">Variables (comma-separated)</label><input class="form-input" id="nt-vars" placeholder="merchant_name, email"></div>' +
    '<div class="form-group"><label class="form-label">HTML Body *</label><textarea class="form-input" id="nt-body" rows="6" placeholder="<p>Dear {{merchant_name}},</p>..."></textarea></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="createTpl()">Create</button></div>' +
    '<div id="nt-msg" style="margin-top:8px"></div>');
}

async function createTpl() {
  var name=document.getElementById('nt-name').value.trim(), slug=document.getElementById('nt-slug').value.trim();
  var subj=document.getElementById('nt-subj').value.trim(), body=document.getElementById('nt-body').value;
  var vars=document.getElementById('nt-vars').value.trim();
  var msg=document.getElementById('nt-msg');
  if (!name||!slug||!subj||!body) { if(msg) msg.innerHTML='<div class="warn-box">All fields except variables are required.</div>'; return; }
  var res=await apiFetch('/admin/email-templates',{method:'POST',body:JSON.stringify({name,slug,subject:subj,htmlBody:body,variables:vars?vars.split(',').map(function(v){return v.trim();}).filter(Boolean):[]})});
  if(msg) msg.innerHTML=res&&res.status?'<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Created!</div>':'<div class="warn-box">&#9888; '+(res&&res.message||'Error')+'</div>';
  if(res&&res.status){document.getElementById('modal').style.display='none';loadEmailTemplates();}
}

// ── 2FA setup helpers (used in settings page) ─────────────────────────────
async function setup2FA() {
  var res = await apiFetch('/auth/2fa/setup', { method:'POST' });
  if (!res||!res.status) { alert('Error: '+(res&&res.message||'Failed')); return; }
  var d = res.data;
  showModal('<div class="modal-header"><div class="modal-title">Set Up Two-Factor Authentication</div><button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div class="info-box" style="margin-bottom:16px;font-size:12px">&#8505; Scan this QR code with Google Authenticator, Authy, or any TOTP app, then enter the 6-digit code to confirm.</div>' +
    '<div style="text-align:center;margin-bottom:16px"><img src="' + d.qr_code + '" style="width:200px;height:200px;border:1px solid var(--gray-200);border-radius:8px"></div>' +
    '<div class="form-group"><label class="form-label">Manual Entry Key</label><input class="form-input mono" value="' + d.secret + '" readonly onclick="this.select()" style="font-size:12px"></div>' +
    '<div class="form-group"><label class="form-label">Enter 6-digit code to activate</label>' +
    '<input class="form-input" id="tfa-code" placeholder="000000" maxlength="6" style="font-size:20px;letter-spacing:4px;text-align:center"></div>' +
    '<div class="flex-between"><button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="enable2FA()">Enable 2FA</button></div>' +
    '<div id="tfa-setup-msg" style="margin-top:8px"></div>');
}

async function enable2FA() {
  var code = document.getElementById('tfa-code').value.trim();
  var msg  = document.getElementById('tfa-setup-msg');
  var res  = await apiFetch('/auth/2fa/enable', { method:'POST', body:JSON.stringify({code}) });
  if (msg) msg.innerHTML = res&&res.status
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; 2FA enabled!</div>'
    : '<div class="warn-box">&#9888; '+(res&&res.message||'Invalid code')+'</div>';
  if (res&&res.status) setTimeout(function(){document.getElementById('modal').style.display='none'; renderPage();}, 1200);
}

async function disable2FA() {
  var pw   = document.getElementById('tfa-dis-pw').value;
  var code = document.getElementById('tfa-dis-code').value.trim();
  var msg  = document.getElementById('tfa-msg');
  var res  = await apiFetch('/auth/2fa/disable', { method:'POST', body:JSON.stringify({password:pw,code}) });
  if (msg) msg.innerHTML = res&&res.status
    ? '<div class="info-box">2FA disabled.</div>'
    : '<div class="warn-box">&#9888; '+(res&&res.message||'Error')+'</div>';
  if (res&&res.status) setTimeout(function(){renderPage();}, 1000);
}

// ── Statement download helpers (merchant role) ────────────────────────────
async function downloadStatement() {
  var month = (document.getElementById('stmt-month')||{}).value || new Date().toISOString().slice(0,7);
  var token = sessionStorage.getItem('paylode_token');
  var res = await fetch('/api/v1/statements/my?month=' + month, { headers:{'Authorization':'Bearer '+token} });
  if (!res.ok) { alert('Failed to generate statement.'); return; }
  var blob = await res.blob();
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a'); a.href=url; a.download='paylode-statement-'+month+'.pdf';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

async function emailStatement() {
  var month = (document.getElementById('stmt-month')||{}).value || new Date().toISOString().slice(0,7);
  var res   = await apiFetch('/statements/my/email?month=' + month, { method:'POST' });
  alert(res&&res.status ? '&#10003; ' + res.message : 'Error: '+(res&&res.message||'Failed'));
}

// ── User Management ───────────────────────────────────────────────────────
var __usersData = [];

function renderUserManagement() {
  setTimeout(loadUsers, 0);
  return '<div class="page-header"><div class="page-title">User Management</div>' +
    '<div class="page-desc">Create and manage platform staff. Role defaults pre-fill permissions — Super Admin can adjust any checkbox.</div></div>' +
    '<div style="display:flex;justify-content:flex-end;margin-bottom:16px">' +
    '<button class="btn btn-lime" onclick="showCreateUserModal()">+ Create User</button></div>' +
    '<div id="users-list"><div class="card"><div style="padding:24px;text-align:center;color:var(--gray-400)">Loading...</div></div></div>';
}

async function loadUsers() {
  var res = await apiFetch('/users');
  var el = document.getElementById('users-list');
  if (!el) return;
  if (!res || !res.status) {
    el.innerHTML = '<div class="warn-box">Failed to load users.</div>';
    return;
  }
  __usersData = res.data || [];
  var roleBadge = { SUPER_ADMIN:'badge-red', ADMIN:'badge-blue', COMPLIANCE_OFFICER:'badge-amber',
                    AUDIT:'badge-gray', MERCHANT:'badge-green', AGGREGATOR:'badge-lime' };
  var me = getUser() || {};
  var rows = __usersData.map(function(u) {
    var rb = roleBadge[u.role] || 'badge-gray';
    var lastLogin = u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never';
    // You can change anyone's role except your own (backend also blocks self + last SA).
    var isSelf = (u.id && u.id === me.id) || (u.email && me.email && u.email.toLowerCase() === (me.email||'').toLowerCase());
    var roleBtn = !isSelf
      ? '<button class="btn btn-outline btn-sm" onclick="showChangeRoleModal(\'' + u.id + '\')" style="margin-right:4px">Role</button>'
      : '';
    var actions = u.role !== 'SUPER_ADMIN'
      ? roleBtn +
        '<button class="btn btn-outline btn-sm" onclick="showEditPermissionsModal(\'' + u.id + '\')" style="margin-right:4px">Permissions</button>' +
        '<button class="btn btn-outline btn-sm" onclick="toggleUserActive(\'' + u.id + '\',' + u.isActive + ')" style="margin-right:4px">' + (u.isActive ? 'Suspend' : 'Activate') + '</button>' +
        '<button class="btn btn-outline btn-sm" style="color:#fff;background:var(--red);border-color:var(--red)" onclick="deleteUser(\'' + u.id + '\',\'' + (u.email||'').replace(/'/g,'') + '\')">Delete</button>'
      : (roleBtn + '<span style="font-size:11px;color:var(--gray-400)">Protected</span>');
    return '<tr>' +
      '<td style="font-weight:500">' + u.firstName + ' ' + u.lastName + '</td>' +
      '<td class="mono" style="font-size:11px">' + u.email + '</td>' +
      '<td><span class="badge ' + rb + '">' + u.role.replace(/_/g,' ') + '</span></td>' +
      '<td><span class="badge ' + (u.isActive ? 'badge-green' : 'badge-gray') + '">' + (u.isActive ? 'Active' : 'Inactive') + '</span></td>' +
      '<td style="font-size:11px;color:var(--gray-400)">' + lastLogin + '</td>' +
      '<td>' + new Date(u.createdAt).toLocaleDateString() + '</td>' +
      '<td><div class="flex" style="gap:4px">' + actions + '</div></td></tr>';
  }).join('') || '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--gray-400)">No users yet. Click "+ Create User" to add one.</td></tr>';
  el.innerHTML = '<div class="card"><div class="card-header"><div class="card-title">Platform Users</div>' +
    '<span class="badge badge-gray">' + __usersData.length + '</span></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th>' +
    '<th>Status</th><th>Last Login</th><th>Created</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div></div>';
}

// Functionality matrix: each row offers View and Edit (View+Edit = full access).
// Checkboxes keep class .perm-cb + data-perm so getCheckedPerms()/onRoleChange() work.
function renderPermCheckboxes(activePerms) {
  var active = Array.isArray(activePerms) ? activePerms : [];
  // Legacy/empty perms → show role defaults for the role being edited (best effort).
  var rows = FUNCTIONALITIES.map(function(f) {
    var vId = viewPerm(f.id), eId = editPerm(f.id);
    var vChecked = active.includes(vId) ? 'checked' : '';
    var label = f.label + (f.sensitive ? ' <span class="badge badge-amber" style="font-size:9px">sensitive</span>' : '');
    var viewCell =
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;justify-content:center">' +
        '<input type="checkbox" class="perm-cb" data-perm="' + vId + '" ' + vChecked + '></label>';
    var editCell = f.edit
      ? '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;justify-content:center" title="' + (f.editLabel || 'Edit') + '">' +
          '<input type="checkbox" class="perm-cb" data-perm="' + eId + '" ' + (active.includes(eId) ? 'checked' : '') +
          ' onchange="if(this.checked){var v=document.querySelector(&quot;.perm-cb[data-perm=\'' + vId + '\']&quot;); if(v) v.checked=true;}"></label>'
      : '<span style="color:var(--gray-300);font-size:11px">—</span>';
    return '<tr style="border-bottom:1px solid var(--gray-100)">' +
      '<td style="padding:6px 8px;font-size:12px">' + label + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + viewCell + '</td>' +
      '<td style="padding:6px 8px;text-align:center">' + editCell + '</td>' +
    '</tr>';
  }).join('');
  return '<div style="font-size:11px;color:var(--gray-400);margin-bottom:8px">Tick <strong>View</strong> for read-only, add <strong>Edit</strong> for full access. Ticking Edit auto-grants View.</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
    '<thead><tr style="border-bottom:2px solid var(--gray-200)">' +
      '<th style="text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--gray-500)">Functionality</th>' +
      '<th style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:var(--gray-500)">View</th>' +
      '<th style="padding:6px 8px;font-size:11px;text-transform:uppercase;color:var(--gray-500)">Edit</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function getCheckedPerms() {
  var perms = [];
  document.querySelectorAll('.perm-cb:checked').forEach(function(cb) { perms.push(cb.dataset.perm); });
  return perms;
}

function onRoleChange() {
  var role = document.getElementById('cu-role').value;
  var defaults = role && PERM_ROLE_DEFAULTS[role] ? PERM_ROLE_DEFAULTS[role] : [];
  document.querySelectorAll('.perm-cb').forEach(function(cb) {
    cb.checked = defaults.includes(cb.dataset.perm);
  });
}

function showCreateUserModal() {
  var opts = ['SUPER_ADMIN','ADMIN','COMPLIANCE_OFFICER','AUDIT','MERCHANT','AGGREGATOR'].map(function(r) {
    return '<option value="' + r + '">' + r.replace(/_/g,' ') + '</option>';
  }).join('');
  showModal(
    '<div class="modal-header"><div class="modal-title">Create User</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    '<div class="form-group"><label class="form-label">First Name *</label><input class="form-input" id="cu-fname" placeholder="First name"></div>' +
    '<div class="form-group"><label class="form-label">Last Name *</label><input class="form-input" id="cu-lname" placeholder="Last name"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">Email *</label><input class="form-input" id="cu-email" type="email" placeholder="user@paylodeservices.com"></div>' +
    '<div class="form-group"><label class="form-label">Role *</label>' +
    '<select class="form-input form-select" id="cu-role" onchange="onRoleChange()">' +
    '<option value="">— Select role —</option>' + opts + '</select>' +
    '<div style="font-size:11px;color:var(--gray-400);margin-top:4px">Selecting a role auto-fills the permissions below. You can adjust them.</div></div>' +
    '<div class="info-box" style="font-size:12px;margin-bottom:12px">A system-generated first-time password will be emailed to the user. They must change it on first sign-in.</div>' +
    '<div style="border-top:1px solid var(--gray-100);margin:4px 0 12px;padding-top:12px">' +
    '<div style="font-size:13px;font-weight:600;margin-bottom:10px">Permissions</div>' +
    '<div id="perm-boxes" style="max-height:300px;overflow-y:auto;padding-right:4px">' + renderPermCheckboxes([]) + '</div></div>' +
    '<div class="flex-between" style="margin-top:8px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="createUser()">Create User</button></div>' +
    '<div id="cu-msg" style="margin-top:8px"></div>'
  );
}

async function createUser() {
  var fname = document.getElementById('cu-fname').value.trim();
  var lname = document.getElementById('cu-lname').value.trim();
  var email = document.getElementById('cu-email').value.trim();
  var role  = document.getElementById('cu-role').value;
  var msg   = document.getElementById('cu-msg');
  if (!fname || !lname || !email || !role) {
    if (msg) msg.innerHTML = '<div class="warn-box">First name, last name, email and role are required.</div>';
    return;
  }
  var perms = getCheckedPerms();
  // First-time-password flow: /users/invite generates + emails a temp password.
  var res = await apiFetch('/users/invite', { method:'POST', body:JSON.stringify({
    name: fname + ' ' + lname, email, role, permissions:perms,
  })});
  if (msg) msg.innerHTML = res && res.status
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; User created. A first-time password has been emailed to ' + email + '.</div>'
    : '<div class="warn-box">&#9888; ' + (res && res.message || 'Error') + '</div>';
  if (res && res.status) setTimeout(function() {
    document.getElementById('modal').style.display = 'none';
    loadUsers();
  }, 900);
}

function showChangeRoleModal(userId) {
  var u = __usersData.find(function(x) { return x.id === userId; });
  if (!u) return;
  var roles = ['SUPER_ADMIN','ADMIN','COMPLIANCE_OFFICER','AUDIT','MERCHANT','AGGREGATOR'];
  var opts = roles.map(function(r) {
    return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r.replace(/_/g,' ') + '</option>';
  }).join('');
  showModal(
    '<div class="modal-header"><div class="modal-title">Change Role</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="font-size:13px;color:var(--gray-500);margin-bottom:12px">' + u.firstName + ' ' + u.lastName +
      ' &nbsp;&middot;&nbsp; <span class="mono" style="font-size:11px">' + u.email + '</span><br>' +
      'Current role: <strong>' + u.role.replace(/_/g,' ') + '</strong></div>' +
    '<div class="form-group"><label class="form-label">New Role *</label>' +
    '<select class="form-input form-select" id="cr-role">' + opts + '</select></div>' +
    '<div class="warn-box" style="font-size:12px">Changing the role <strong>resets this user\'s permissions</strong> to the new role\'s defaults. Super Admin has full, unrestricted access.</div>' +
    '<div class="flex-between" style="margin-top:8px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="changeUserRole(\'' + u.id + '\')">Update Role</button></div>' +
    '<div id="cr-msg" style="margin-top:8px"></div>'
  );
}

async function changeUserRole(userId) {
  var role = document.getElementById('cr-role').value;
  var msg  = document.getElementById('cr-msg');
  var res  = await apiFetch('/users/' + userId + '/role', {
    method:'PATCH', body:JSON.stringify({ role: role }),
  });
  if (msg) msg.innerHTML = res && res.status
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; ' + (res.message || 'Role updated.') + '</div>'
    : '<div class="warn-box">&#9888; ' + (res && res.message || 'Error') + '</div>';
  if (res && res.status) setTimeout(function() {
    document.getElementById('modal').style.display = 'none';
    loadUsers();
  }, 900);
}

function showEditPermissionsModal(userId) {
  var u = __usersData.find(function(x) { return x.id === userId; });
  if (!u) return;
  // Effective perms: legacy/empty users show their role defaults (matches the
  // self-healing fallback in userHasPerm) so the matrix reflects real access.
  var stored = Array.isArray(u.permissions) ? u.permissions : [];
  var hasNewVocab = stored.some(function(p){ return p.indexOf('view_') === 0 || p.indexOf('edit_') === 0; });
  var effective = hasNewVocab ? stored : (PERM_ROLE_DEFAULTS[(u.role||'').toUpperCase()] || []);
  showModal(
    '<div class="modal-header"><div class="modal-title">Permissions — ' + u.firstName + ' ' + u.lastName + '</div>' +
    '<button class="modal-close" onclick="document.getElementById(\'modal\').style.display=\'none\'">&#10005;</button></div>' +
    '<div style="font-size:12px;color:var(--gray-500);margin-bottom:12px">' +
    'Role: <strong>' + u.role.replace(/_/g,' ') + '</strong> &nbsp;|&nbsp; ' +
    '<span style="color:var(--gray-400)">' + effective.length + ' permissions active</span></div>' +
    '<div style="max-height:380px;overflow-y:auto;padding-right:4px">' + renderPermCheckboxes(effective) + '</div>' +
    '<div class="flex-between" style="margin-top:16px">' +
    '<button class="btn btn-outline" onclick="document.getElementById(\'modal\').style.display=\'none\'">Cancel</button>' +
    '<button class="btn btn-lime" onclick="saveUserPermissions(\'' + userId + '\')">Save Permissions</button></div>' +
    '<div id="ep-msg" style="margin-top:8px"></div>'
  );
}

async function saveUserPermissions(userId) {
  var perms = getCheckedPerms();
  var msg = document.getElementById('ep-msg');
  var res = await apiFetch('/users/' + userId + '/permissions', {
    method:'PATCH', body:JSON.stringify({ permissions:perms }),
  });
  if (msg) msg.innerHTML = res && res.status
    ? '<div class="info-box" style="background:#f0fdf4;border-color:#bbf7d0;color:#166534">&#10003; Permissions saved.</div>'
    : '<div class="warn-box">&#9888; ' + (res && res.message || 'Error') + '</div>';
  if (res && res.status) setTimeout(function() {
    document.getElementById('modal').style.display = 'none';
    loadUsers();
  }, 700);
}

async function toggleUserActive(userId, currentlyActive) {
  if (!confirm((currentlyActive ? 'Suspend' : 'Activate') + ' this user?')) return;
  var res = await apiFetch('/users/' + userId, {
    method:'PATCH', body:JSON.stringify({ isActive: !currentlyActive }),
  });
  if (!res || !res.status) { alert(res && res.message || 'Error'); return; }
  loadUsers();
}

// SA: delete a staff user (backend refuses self / last Super Admin / merchant-
// aggregator logins / users with audit history — suspend those instead).
async function deleteUser(userId, email) {
  if (!confirm('Delete user ' + email + '?\n\nOnly allowed for staff accounts with no audit history. Accounts that have taken actions should be Suspended instead.')) return;
  var res = await apiFetch('/users/' + userId, { method:'DELETE' });
  if (res && res.status) { alert(email + ' deleted.'); loadUsers(); }
  else alert((res && res.message) || 'Delete failed');
}

// Register the idle-logout timer FIRST, before any render code that could throw —
// a render error must never leave a session running without an inactivity timeout.
setupInactivityTimeout();
try { renderNav(); }  catch (e) { console.error('renderNav failed', e); }
try { renderPage(); } catch (e) { console.error('renderPage failed', e); }

// ── Auth helpers (required by api-wiring.js) ──────────────────────────────
function getUser() {
  try { return JSON.parse(sessionStorage.getItem('paylode_user') || 'null'); }
  catch (e) { return null; }
}

var API_BASE = '/api/v1';

async function apiFetch(path, options) {
  var token = sessionStorage.getItem('paylode_token');
  var opts  = options || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;

  var res = await fetch(API_BASE + path, Object.assign({}, opts, { headers: headers }));

  if (res.status === 401) {
    sessionStorage.removeItem('paylode_token');
    sessionStorage.removeItem('paylode_user');
    window.location.href = '/login.html';
    return null;
  }

  return res.json();
}
// ── Inactivity timeout (5 minutes) ───────────────────────────────────────────
// Hoisted function declaration — CALLED from the init block above (before render),
// so it always registers even if a page renderer throws.
function setupInactivityTimeout() {
  var TIMEOUT_MS = 5 * 60 * 1000;
  var lastActive  = Date.now();
  var timer;

  function doLogout() {
    sessionStorage.removeItem('paylode_token');
    sessionStorage.removeItem('paylode_user');
    sessionStorage.removeItem('paylode_selected_role');
    window.location.href = '/login.html?reason=timeout';
  }

  function checkElapsed() {
    if (Date.now() - lastActive >= TIMEOUT_MS) doLogout();
  }

  function resetTimer() {
    lastActive = Date.now();
    clearTimeout(timer);
    timer = setTimeout(doLogout, TIMEOUT_MS);
  }

  // Catch browsers that throttle background-tab timers, and machines that sleep:
  // when the tab becomes visible / regains focus / is restored from bfcache,
  // re-check whether the idle window has already elapsed.
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) checkElapsed();
  });
  window.addEventListener('focus', checkElapsed);
  window.addEventListener('pageshow', checkElapsed);

  ['mousemove', 'mousedown', 'keypress', 'touchstart', 'scroll', 'click'].forEach(function(evt) {
    document.addEventListener(evt, resetTimer, true);
  });

  resetTimer();
}
