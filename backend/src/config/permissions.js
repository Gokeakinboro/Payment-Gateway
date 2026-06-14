'use strict';

// ──────────────────────────────────────────────────────────────────────────────
//  FUNCTIONALITY-BASED PERMISSIONS  (view / edit per functionality)
//  Each functionality yields a `view_<id>` perm and, where `edit` is true,
//  an `edit_<id>` perm. Granting both view+edit == "All" for that functionality.
//  SUPER_ADMIN bypasses every check (see hasPermission). These perms add
//  granularity for ADMIN / COMPLIANCE_OFFICER / AUDIT staff accounts.
// ──────────────────────────────────────────────────────────────────────────────

const FUNCTIONALITIES = [
  { id: 'dashboard',        label: 'Dashboard Overview',                 edit: false },
  { id: 'transactions',     label: 'Transactions',                       edit: true,  editLabel: 'Export / refund' },
  { id: 'merchants',        label: 'Merchants',                          edit: true },
  { id: 'merchant_contact', label: 'Merchant / Aggregator Contact Details', edit: false, sensitive: true },
  { id: 'aggregators',      label: 'Aggregators',                        edit: true },
  { id: 'onboarding',       label: 'Onboarding / Applications',          edit: true,  editLabel: 'Onboard / submit' },
  { id: 'compliance',       label: 'Compliance / KYC Review',            edit: true,  editLabel: 'Approve / reject' },
  { id: 'doc_referrals',    label: 'Document Referrals',                 edit: true,  editLabel: 'Request / resolve' },
  { id: 'settlements',      label: 'Settlements',                        edit: true,  editLabel: 'Approve / process' },
  { id: 'payouts',          label: 'Payouts',                            edit: true,  editLabel: 'Process / mark paid' },
  { id: 'wallets',          label: 'Merchant Wallets / Credit',          edit: true,  editLabel: 'Fund / adjust' },
  { id: 'chargebacks',      label: 'Chargebacks',                        edit: true,  editLabel: 'Resolve' },
  { id: 'reports',          label: 'Reports',                            edit: true,  editLabel: 'Download' },
  { id: 'revenue',          label: 'Revenue',                            edit: false },
  { id: 'rails',            label: 'Payment Rails',                      edit: true },
  { id: 'fees',             label: 'Fee Configuration',                  edit: true },
  { id: 'email_tpl',        label: 'Email Templates',                    edit: true },
  { id: 'webhooks',         label: 'Webhooks',                           edit: true },
  { id: 'staff',            label: 'Staff Accounts',                     edit: true,  editLabel: 'Create / manage' },
  { id: 'settings',         label: 'Platform Settings',                  edit: true },
];

function viewPerm(id) { return 'view_' + id; }
function editPerm(id) { return 'edit_' + id; }

const ALL_PERMISSIONS = FUNCTIONALITIES.reduce((acc, f) => {
  acc.push(viewPerm(f.id));
  if (f.edit) acc.push(editPerm(f.id));
  return acc;
}, []);

// Helper: grant view (+edit) for a list of functionality ids
function grant(ids, withEdit) {
  const out = [];
  ids.forEach((id) => {
    out.push(viewPerm(id));
    if (withEdit) {
      const f = FUNCTIONALITIES.find((x) => x.id === id);
      if (f && f.edit) out.push(editPerm(id));
    }
  });
  return out;
}

// Functionalities a role can VIEW and EDIT by default. merchant_contact is
// intentionally NOT granted to anyone but SUPER_ADMIN (see #8) — SA can tick it
// per-user. Compliance is strictly view-only on merchants/aggregators and has
// NO settlements / payouts / staff (see #6).
const ROLE_DEFAULTS = {
  SUPER_ADMIN: ALL_PERMISSIONS,

  ADMIN: [].concat(
    grant(['dashboard', 'revenue'], false),
    grant([
      'transactions', 'merchants', 'aggregators', 'onboarding', 'compliance',
      'doc_referrals', 'settlements', 'payouts', 'wallets', 'chargebacks',
      'reports', 'rails', 'webhooks',
    ], true),
    grant(['staff'], false), // admin can view staff but not create staff by default
  ),

  COMPLIANCE_OFFICER: [].concat(
    grant(['dashboard', 'merchants', 'aggregators', 'transactions', 'revenue'], false), // VIEW ONLY
    grant(['compliance', 'doc_referrals', 'reports'], true),                             // can act
  ),

  AUDIT: [].concat(
    grant([
      'dashboard', 'transactions', 'merchants', 'aggregators', 'settlements',
      'payouts', 'chargebacks', 'compliance', 'revenue',
    ], false), // view-only across the board
    grant(['reports'], true), // download reports
  ),

  MERCHANT: [].concat(
    grant(['dashboard', 'transactions', 'settlements', 'reports'], false),
    grant(['webhooks'], true),
  ),

  AGGREGATOR: [].concat(
    grant(['dashboard', 'transactions', 'settlements', 'merchants', 'reports'], false),
    grant(['onboarding'], true),
  ),
};

function defaultsForRole(role) {
  return (ROLE_DEFAULTS[role] || []).slice();
}

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

module.exports = {
  FUNCTIONALITIES,
  ALL_PERMISSIONS,
  ROLE_DEFAULTS,
  viewPerm,
  editPerm,
  defaultsForRole,
  hasPermission,
};
