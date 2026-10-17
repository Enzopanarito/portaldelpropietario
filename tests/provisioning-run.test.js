'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCountryPack } = require('../platform/core/country-pack');
const { buildProvisioningPlan } = require('../platform/provisioning/tenant-provisioning');
const { manifestHash, createRunDescriptor, replayProvisioning } = require('../platform/provisioning/provisioning-run');

const root = path.join(__dirname, '..');
const ve = loadCountryPack(path.join(root, 'config', 'country-packs', 've.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config', 'tenant-provisioning', 've-pilot.example.json'), 'utf8'));
const plan = buildProvisioningPlan(manifest, ve);

test('manifest hash is deterministic regardless of object key order', () => {
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(manifestHash(manifest), manifestHash(reordered));
  assert.match(manifestHash(manifest), /^[0-9a-f]{64}$/);
});

test('run descriptor is deterministic and starts at first plan step', () => {
  const run = createRunDescriptor({ manifest, countryPack: ve, idempotencyKey: 'tenant:residencias-piloto:v1' });
  assert.equal(run.tenantSlug, 'residencias-piloto');
  assert.equal(run.status, 'running');
  assert.equal(run.currentStepCode, plan.steps[0].code);
  assert.equal(run.manifestHash, manifestHash(manifest));
});

test('successful events advance to the next incomplete step', () => {
  const first = plan.steps[0].code;
  const second = plan.steps[1].code;
  const state = replayProvisioning(plan, [
    { stepCode: first, attempt: 1, status: 'started' },
    { stepCode: first, attempt: 1, status: 'completed' },
    { stepCode: second, attempt: 1, status: 'started' }
  ]);
  assert.equal(state.status, 'running');
  assert.equal(state.currentStepCode, second);
  assert.equal(state.nextAttempt, 1);
  assert.deepEqual(state.completedSteps, [first]);
});

test('failed step resumes the same step with incremented attempt', () => {
  const first = plan.steps[0].code;
  const state = replayProvisioning(plan, [
    { stepCode: first, attempt: 1, status: 'started' },
    { stepCode: first, attempt: 1, status: 'failed', errorCode: 'COUNTRY_REVIEW_BLOCKED' }
  ]);
  assert.equal(state.status, 'failed');
  assert.equal(state.currentStepCode, first);
  assert.equal(state.nextAttempt, 2);
  assert.equal(state.errorCode, 'COUNTRY_REVIEW_BLOCKED');
});

test('retry can complete failed step without recreating prior resources', () => {
  const first = plan.steps[0].code;
  const state = replayProvisioning(plan, [
    { stepCode: first, attempt: 1, status: 'started' },
    { stepCode: first, attempt: 1, status: 'failed', errorCode: 'TEMPORARY' },
    { stepCode: first, attempt: 2, status: 'started' },
    { stepCode: first, attempt: 2, status: 'completed' }
  ]);
  assert.equal(state.status, 'running');
  assert.equal(state.currentStepCode, plan.steps[1].code);
  assert.deepEqual(state.completedSteps, [first]);
});

test('out-of-order events are rejected', () => {
  assert.throws(
    () => replayProvisioning(plan, [{ stepCode: plan.steps[2].code, attempt: 1, status: 'started' }]),
    error => error.code === 'PROVISIONING_EVENT_OUT_OF_ORDER'
  );
});

test('all completed steps produce completed run', () => {
  const events = [];
  for (const step of plan.steps) {
    events.push({ stepCode: step.code, attempt: 1, status: 'started' });
    events.push({ stepCode: step.code, attempt: 1, status: 'completed' });
  }
  const state = replayProvisioning(plan, events);
  assert.equal(state.status, 'completed');
  assert.equal(state.currentStepCode, null);
  assert.equal(state.completedSteps.length, plan.steps.length);
});
