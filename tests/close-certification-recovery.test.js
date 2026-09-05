'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUDIENCE,
  REPOSITORY,
  WORKFLOW,
  WORKFLOW_REF,
  REF,
  validateClaims
} = require('../netlify/functions/_shared/_github_oidc_close_recovery');
const { normalizePaymentIds } = require('../netlify/functions/recover-august-close-certification');

function validClaims(now = 1_800_000_000) {
  return {
    iss: 'https://token.actions.githubusercontent.com',
    aud: AUDIENCE,
    repository: REPOSITORY,
    repository_owner: 'Enzopanarito',
    workflow: WORKFLOW,
    workflow_ref: WORKFLOW_REF,
    ref: REF,
    event_name: 'workflow_run',
    runner_environment: 'github-hosted',
    run_id: '123456789',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300
  };
}

test('OIDC de recuperación acepta únicamente workflow_run de main y workflow exacto', () => {
  const now = 1_800_000_000;
  assert.equal(validateClaims(validClaims(now), now).workflow, WORKFLOW);
  for (const [field, value] of [
    ['aud', 'otro-audience'],
    ['workflow', 'Otro Workflow'],
    ['workflow_ref', WORKFLOW_REF.replace('@refs/heads/main', '@refs/heads/otra')],
    ['ref', 'refs/heads/otra'],
    ['event_name', 'push'],
    ['runner_environment', 'self-hosted']
  ]) {
    const claims = validClaims(now);
    claims[field] = value;
    assert.throws(() => validateClaims(claims, now));
  }
});

test('la recuperación exige exactamente 48 IDs Airtable únicos', () => {
  const ids = Array.from({ length: 48 }, (_, index) => `rec${index.toString(36).padStart(14, '0')}`);
  const normalized = normalizePaymentIds(ids);
  assert.equal(normalized.length, 48);
  assert.deepEqual(normalized, [...ids].sort());
  assert.throws(() => normalizePaymentIds(ids.slice(0, 47)), /PAYMENT_IDS_COUNT_INVALID/);
  const duplicated = [...ids];
  duplicated[47] = duplicated[0];
  assert.throws(() => normalizePaymentIds(duplicated), /PAYMENT_IDS_DUPLICATED/);
  const malformed = [...ids];
  malformed[10] = 'not-an-airtable-record';
  assert.throws(() => normalizePaymentIds(malformed), /PAYMENT_ID_INVALID/);
});
