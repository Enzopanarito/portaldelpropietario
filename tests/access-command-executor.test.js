'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeAccessDecision } = require('../platform/core/access-command-executor');
const { ACTIONS } = require('../platform/core/access-policy-engine');

function decision(action, reasonCode = 'TEST') {
  return { action, reasonCode, desiredEnabled: action === ACTIONS.ENABLE };
}

function provider(calls, result = { providerStatus: 200 }) {
  return {
    id: 'mock-access',
    supports(capability) { return capability === 'credential-state'; },
    async setCredentialState(input) { calls.push(input); return result; }
  };
}

test('NONE and REVIEW never call hardware', async () => {
  for (const action of [ACTIONS.NONE, ACTIONS.REVIEW]) {
    const calls = [];
    const result = await executeAccessDecision({ decision: decision(action), provider: provider(calls), dryRun: false });
    assert.equal(result.providerCalled, false);
    assert.equal(calls.length, 0);
  }
});

test('dry-run plans an actionable command without touching provider or audit', async () => {
  const calls = [];
  const audits = [];
  const result = await executeAccessDecision({
    decision: decision(ACTIONS.DISABLE, 'OVERDUE_DEBT_REQUIRES_FINANCIAL_RESTRICTION'),
    provider: provider(calls),
    externalCredentialId: 'member-1',
    auditWriter: async event => audits.push(event),
    dryRun: true,
    executionId: 'dry-1'
  });
  assert.equal(result.executed, false);
  assert.equal(result.providerCalled, false);
  assert.equal(calls.length, 0);
  assert.equal(audits.length, 0);
});

test('live command requires requested audit before provider call and completion audit after', async () => {
  const sequence = [];
  const mockProvider = {
    id: 'mkj',
    supports: () => true,
    async setCredentialState(input) { sequence.push(['provider', input]); return { providerStatus: 200, idempotent: true }; }
  };
  const result = await executeAccessDecision({
    decision: decision(ACTIONS.DISABLE, 'OVERDUE_DEBT_REQUIRES_FINANCIAL_RESTRICTION'),
    provider: mockProvider,
    externalCredentialId: '77',
    email: 'owner@example.com',
    auditWriter: async event => sequence.push(['audit', event.action]),
    dryRun: false,
    executionId: 'live-1'
  });
  assert.equal(result.executed, true);
  assert.deepEqual(sequence.map(x => x[0] === 'audit' ? x[1] : 'provider'), [
    'access.command.requested', 'provider', 'access.command.completed'
  ]);
  assert.equal(sequence[1][1].enabled, false);
});

test('audit pre-write failure prevents physical command', async () => {
  const calls = [];
  await assert.rejects(() => executeAccessDecision({
    decision: decision(ACTIONS.ENABLE, 'OVERDUE_DEBT_CLEARED'),
    provider: provider(calls),
    externalCredentialId: '77',
    auditWriter: async () => { throw Object.assign(new Error('db down'), { code: 'AUDIT_DOWN' }); },
    dryRun: false
  }), error => error.code === 'AUDIT_DOWN');
  assert.equal(calls.length, 0);
});

test('provider failure is followed by a failure audit without leaking email into audit metadata', async () => {
  const audits = [];
  const mockProvider = {
    id: 'mkj',
    supports: () => true,
    async setCredentialState() { throw Object.assign(new Error('provider unavailable'), { code: 'MKJ_DOWN' }); }
  };
  await assert.rejects(() => executeAccessDecision({
    decision: decision(ACTIONS.DISABLE),
    provider: mockProvider,
    externalCredentialId: '77',
    email: 'private@example.com',
    auditWriter: async event => audits.push(event),
    dryRun: false,
    executionId: 'failed-1'
  }), error => error.code === 'MKJ_DOWN');
  assert.deepEqual(audits.map(x => x.action), ['access.command.requested', 'access.command.failed']);
  assert.equal(JSON.stringify(audits).includes('private@example.com'), false);
  assert.equal(audits[1].metadata.errorCode, 'MKJ_DOWN');
});

test('completion audit failure is explicit because hardware may already have changed', async () => {
  let auditCount = 0;
  const calls = [];
  await assert.rejects(() => executeAccessDecision({
    decision: decision(ACTIONS.ENABLE),
    provider: provider(calls, { providerStatus: 200 }),
    externalCredentialId: '77',
    auditWriter: async () => {
      auditCount += 1;
      if (auditCount === 2) throw new Error('audit completion failed');
    },
    dryRun: false,
    executionId: 'audit-fail-1'
  }), error => error.code === 'ACCESS_COMPLETION_AUDIT_FAILED' && error.hardwareChanged === true);
  assert.equal(calls.length, 1);
});

test('provider without credential-state capability is rejected', async () => {
  await assert.rejects(() => executeAccessDecision({
    decision: decision(ACTIONS.DISABLE),
    provider: { id: 'weak', supports: () => false, setCredentialState: async () => ({}) },
    externalCredentialId: '77'
  }), error => error.code === 'ACCESS_PROVIDER_CAPABILITY_MISSING');
});
