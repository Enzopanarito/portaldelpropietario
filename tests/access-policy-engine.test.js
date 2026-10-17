'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFinancialAccessDecision, ACTIONS } = require('../platform/core/access-policy-engine');

function policy(enabled) {
  return { access: { debtRestriction: { enabled } } };
}

test('debt cannot disable access when tenant policy has financial restriction off', () => {
  const result = evaluateFinancialAccessDecision({
    tenantPolicy: policy(false),
    overdueByCurrency: [{ currencyCode: 'USD', amountDue: '500' }],
    currentAccess: { enabled: true }
  });
  assert.equal(result.action, ACTIONS.NONE);
  assert.equal(result.reasonCode, 'FINANCIAL_RESTRICTION_POLICY_DISABLED');
  assert.equal(result.hasOverdueDebt, true);
});

test('turning financial restriction off cleans up only an existing financial restriction', () => {
  const financial = evaluateFinancialAccessDecision({
    tenantPolicy: policy(false), overdueByCurrency: [], currentAccess: { enabled: false, restrictionReason: 'financial' }
  });
  const security = evaluateFinancialAccessDecision({
    tenantPolicy: policy(false), overdueByCurrency: [], currentAccess: { enabled: false, restrictionReason: 'security' }
  });
  assert.equal(financial.action, ACTIONS.ENABLE);
  assert.equal(security.action, ACTIONS.NONE);
  assert.equal(security.desiredEnabled, false);
});

test('validated policy can restrict when any currency has overdue debt', () => {
  const result = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true),
    overdueByCurrency: [
      { currencyCode: 'USD', amountDue: '0' },
      { currencyCode: 'VES', amountDue: '1000' }
    ],
    currentAccess: { enabled: true }
  });
  assert.equal(result.action, ACTIONS.DISABLE);
  assert.equal(result.desiredEnabled, false);
  assert.deepEqual(result.overdue.map(x => [x.currencyCode, x.amountDue]), [['VES', '1000']]);
});

test('credits never offset overdue debt in another currency', () => {
  assert.throws(() => evaluateFinancialAccessDecision({
    tenantPolicy: policy(true),
    overdueByCurrency: [
      { currencyCode: 'USD', amountDue: '70' },
      { currencyCode: 'VES', amountDue: '-294.76' }
    ],
    currentAccess: { enabled: true }
  }), error => error.code === 'ACCESS_OVERDUE_NEGATIVE');
});

test('cleared overdue debt only auto-enables restrictions marked financial', () => {
  const financial = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [], currentAccess: { enabled: false, restrictionReason: 'financial' }
  });
  const manual = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [], currentAccess: { enabled: false, restrictionReason: 'manual' }
  });
  assert.equal(financial.action, ACTIONS.ENABLE);
  assert.equal(financial.reasonCode, 'OVERDUE_DEBT_CLEARED');
  assert.equal(manual.action, ACTIONS.NONE);
  assert.equal(manual.reasonCode, 'NON_FINANCIAL_RESTRICTION_PRESERVED');
});

test('stale or inconsistent financial data fails closed without changing hardware', () => {
  const stale = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [{currencyCode:'USD',amountDue:'100'}], dataFresh: false
  });
  const inconsistent = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [{currencyCode:'USD',amountDue:'100'}], consistent: false
  });
  assert.equal(stale.action, ACTIONS.REVIEW);
  assert.equal(stale.requiresHuman, true);
  assert.equal(inconsistent.action, ACTIONS.REVIEW);
  assert.equal(inconsistent.requiresHuman, true);
});

test('missing credential never becomes a hardware command', () => {
  const result = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [{currencyCode:'USD',amountDue:'100'}], credentialConfigured: false
  });
  assert.equal(result.action, ACTIONS.REVIEW);
  assert.equal(result.reasonCode, 'CREDENTIAL_NOT_CONFIGURED');
});

test('already disabled for security is never relabeled as financial', () => {
  const result = evaluateFinancialAccessDecision({
    tenantPolicy: policy(true), overdueByCurrency: [{currencyCode:'USD',amountDue:'100'}], currentAccess: { enabled: false, restrictionReason: 'security' }
  });
  assert.equal(result.action, ACTIONS.NONE);
  assert.equal(result.reasonCode, 'NON_FINANCIAL_RESTRICTION_PRESERVED');
});
