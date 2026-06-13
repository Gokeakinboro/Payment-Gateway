'use strict';

const ALL_PERMISSIONS = [
  // Panels
  'panel_dashboard', 'panel_transactions', 'panel_merchants', 'panel_settlements',
  'panel_chargebacks', 'panel_compliance', 'panel_audit_log', 'panel_bulk_ops',
  'panel_kyc', 'panel_aggregators', 'panel_webhooks', 'panel_payouts',
  'panel_reports', 'panel_rails',
  // Actions
  'action_approve_kyc', 'action_bulk_approve_kyc', 'action_process_refund',
  'action_manage_webhooks', 'action_mark_payout_paid', 'action_resolve_chargeback',
  'action_manage_compliance', 'action_download_reports', 'action_csv_import',
  'action_edit_merchant', 'action_edit_aggregator', 'action_manage_rails',
  // User creation
  'create_admin', 'create_compliance', 'create_audit', 'create_merchant', 'create_aggregator',
];

const ROLE_DEFAULTS = {
  SUPER_ADMIN: ALL_PERMISSIONS,
  ADMIN: [
    'panel_dashboard', 'panel_transactions', 'panel_merchants', 'panel_settlements',
    'panel_chargebacks', 'panel_bulk_ops', 'panel_kyc', 'panel_aggregators',
    'panel_webhooks', 'panel_payouts', 'panel_reports', 'panel_rails',
    'action_approve_kyc', 'action_bulk_approve_kyc', 'action_process_refund',
    'action_manage_webhooks', 'action_mark_payout_paid', 'action_resolve_chargeback',
    'action_download_reports', 'action_csv_import', 'action_edit_merchant',
    'action_edit_aggregator', 'action_manage_rails',
    'create_compliance', 'create_audit', 'create_merchant', 'create_aggregator',
  ],
  COMPLIANCE_OFFICER: [
    'panel_dashboard', 'panel_transactions', 'panel_compliance', 'panel_reports',
    'panel_audit_log', 'panel_merchants',
    'action_manage_compliance', 'action_download_reports',
  ],
  AUDIT: [
    'panel_dashboard', 'panel_transactions', 'panel_audit_log', 'panel_reports',
    'panel_merchants', 'panel_settlements', 'panel_chargebacks', 'panel_kyc',
    'panel_aggregators',
    'action_download_reports',
  ],
  MERCHANT: [
    'panel_dashboard', 'panel_transactions', 'panel_settlements', 'panel_reports',
    'panel_webhooks',
    'action_manage_webhooks', 'action_download_reports',
  ],
  AGGREGATOR: [
    'panel_dashboard', 'panel_transactions', 'panel_settlements', 'panel_aggregators',
    'panel_merchants', 'panel_payouts', 'panel_reports',
    'action_download_reports', 'action_manage_webhooks',
  ],
};

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'SUPER_ADMIN') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(perm);
}

module.exports = { ALL_PERMISSIONS, ROLE_DEFAULTS, hasPermission };
