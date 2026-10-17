'use strict';

const { parseFixed, formatFixed } = require('./fixed-decimal');
const { normalizeCurrency } = require('./financial-ledger');

const ACTIONS = Object.freeze({
  NONE: 'NONE',
  ENABLE: 'ENABLE',
  DISABLE: 'DISABLE',
  REVIEW: 'REVIEW'
});

const RESTRICTION_REASONS = new Set(['none', 'financial', 'manual', 'security', 'unknown']);

function normalizeCurrentAccess(currentAccess = {}) {
  const enabled = currentAccess.enabled !== false;
  const restrictionReason = enabled
    ? 'none'
    : RESTRICTION_REASONS.has(String(currentAccess.restrictionReason || 'unknown'))
      ? String(currentAccess.restrictionReason || 'unknown')
      : 'unknown';
  return Object.freeze({ enabled, restrictionReason });
}

function normalizeOverdue(overdueByCurrency = []) {
  if (!Array.isArray(overdueByCurrency)) {
    throw Object.assign(new Error('overdueByCurrency must be an array'), { code: 'ACCESS_OVERDUE_INVALID' });
  }
  const totals = new Map();
  for (const row of overdueByCurrency) {
    const currencyCode = normalizeCurrency(row?.currencyCode ?? row?.currency_code);
    const amount = parseFixed(row?.amountDue ?? row?.amount_due ?? row?.amount ?? '0');
    if (amount < 0n) {
      throw Object.assign(new Error('Overdue amount cannot be negative'), { code: 'ACCESS_OVERDUE_NEGATIVE' });
    }
    totals.set(currencyCode, (totals.get(currencyCode) || 0n) + amount);
  }
  return Object.freeze([...totals.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, amount]) => Object.freeze({ currencyCode, amountDue: formatFixed(amount), amountScaled: amount })));
}

function decision({ action, reasonCode, requiresHuman = false, overdue, currentAccess, desiredEnabled = currentAccess.enabled }) {
  return Object.freeze({
    action,
    reasonCode,
    requiresHuman,
    desiredEnabled,
    currentAccess,
    overdue,
    hasOverdueDebt: overdue.length > 0
  });
}

function evaluateFinancialAccessDecision({
  tenantPolicy,
  overdueByCurrency = [],
  currentAccess = {},
  credentialConfigured = true,
  dataFresh = true,
  consistent = true
} = {}) {
  if (!tenantPolicy?.access?.debtRestriction || typeof tenantPolicy.access.debtRestriction.enabled !== 'boolean') {
    throw Object.assign(new Error('A validated tenant policy is required'), { code: 'ACCESS_POLICY_REQUIRED' });
  }

  const current = normalizeCurrentAccess(currentAccess);
  const overdue = normalizeOverdue(overdueByCurrency);

  if (!credentialConfigured) {
    return decision({ action: ACTIONS.REVIEW, reasonCode: 'CREDENTIAL_NOT_CONFIGURED', requiresHuman: true, overdue, currentAccess: current });
  }
  if (!dataFresh) {
    return decision({ action: ACTIONS.REVIEW, reasonCode: 'FINANCIAL_DATA_STALE', requiresHuman: true, overdue, currentAccess: current });
  }
  if (!consistent) {
    return decision({ action: ACTIONS.REVIEW, reasonCode: 'FINANCIAL_DATA_INCONSISTENT', requiresHuman: true, overdue, currentAccess: current });
  }

  const restrictionEnabled = tenantPolicy.access.debtRestriction.enabled === true;
  if (!restrictionEnabled) {
    if (!current.enabled && current.restrictionReason === 'financial') {
      return decision({ action: ACTIONS.ENABLE, reasonCode: 'FINANCIAL_RESTRICTION_POLICY_DISABLED', overdue, currentAccess: current, desiredEnabled: true });
    }
    return decision({ action: ACTIONS.NONE, reasonCode: 'FINANCIAL_RESTRICTION_POLICY_DISABLED', overdue, currentAccess: current });
  }

  if (overdue.length > 0) {
    if (!current.enabled) {
      return decision({
        action: ACTIONS.NONE,
        reasonCode: current.restrictionReason === 'financial' ? 'ALREADY_FINANCIALLY_RESTRICTED' : 'NON_FINANCIAL_RESTRICTION_PRESERVED',
        overdue,
        currentAccess: current,
        desiredEnabled: false
      });
    }
    return decision({ action: ACTIONS.DISABLE, reasonCode: 'OVERDUE_DEBT_REQUIRES_FINANCIAL_RESTRICTION', overdue, currentAccess: current, desiredEnabled: false });
  }

  if (!current.enabled && current.restrictionReason === 'financial') {
    return decision({ action: ACTIONS.ENABLE, reasonCode: 'OVERDUE_DEBT_CLEARED', overdue, currentAccess: current, desiredEnabled: true });
  }

  return decision({
    action: ACTIONS.NONE,
    reasonCode: !current.enabled ? 'NON_FINANCIAL_RESTRICTION_PRESERVED' : 'NO_OVERDUE_DEBT',
    overdue,
    currentAccess: current,
    desiredEnabled: current.enabled
  });
}

module.exports = {
  ACTIONS,
  normalizeCurrentAccess,
  normalizeOverdue,
  evaluateFinancialAccessDecision
};
