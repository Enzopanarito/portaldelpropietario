'use strict';

const crypto = require('node:crypto');
const { buildProvisioningPlan } = require('./tenant-provisioning');

function invariant(condition, message, code = 'PROVISIONING_RUN_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function manifestHash(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(manifest))).digest('hex');
}

function createRunDescriptor({ manifest, countryPack, idempotencyKey }) {
  invariant(/^[a-zA-Z0-9:_-]{8,160}$/.test(String(idempotencyKey || '')), 'Invalid provisioning idempotency key', 'PROVISIONING_IDEMPOTENCY_KEY_INVALID');
  const plan = buildProvisioningPlan(manifest, countryPack);
  return Object.freeze({
    tenantSlug: plan.tenantSlug,
    idempotencyKey,
    manifestHash: manifestHash(manifest),
    plan,
    status: 'running',
    currentStepCode: plan.steps[0].code
  });
}

function replayProvisioning(plan, events = []) {
  invariant(plan && Array.isArray(plan.steps) && plan.steps.length > 0, 'Provisioning plan steps are required');
  invariant(Array.isArray(events), 'Provisioning events must be an array');

  const stepCodes = plan.steps.map(step => step.code);
  const position = new Map(stepCodes.map((code, index) => [code, index]));
  const attempts = new Map();
  const completed = new Set();
  const seen = new Set();
  let activeFailure = null;
  let activeStarted = null;

  for (const event of events) {
    invariant(event && typeof event === 'object', 'Invalid provisioning event');
    invariant(position.has(event.stepCode), `Unknown provisioning step: ${event.stepCode}`, 'PROVISIONING_EVENT_UNKNOWN_STEP');
    invariant(Number.isInteger(event.attempt) && event.attempt > 0, 'Provisioning attempt must be positive integer', 'PROVISIONING_EVENT_ATTEMPT_INVALID');
    invariant(['started','completed','failed','skipped'].includes(event.status), 'Invalid provisioning event status', 'PROVISIONING_EVENT_STATUS_INVALID');

    const eventKey = `${event.stepCode}:${event.attempt}:${event.status}`;
    invariant(!seen.has(eventKey), 'Duplicate provisioning event', 'PROVISIONING_EVENT_DUPLICATE');
    seen.add(eventKey);

    const stepIndex = position.get(event.stepCode);
    for (let index = 0; index < stepIndex; index += 1) {
      invariant(completed.has(stepCodes[index]), `Step ${event.stepCode} occurred before ${stepCodes[index]} completed`, 'PROVISIONING_EVENT_OUT_OF_ORDER');
    }

    const priorAttempt = attempts.get(event.stepCode) || 0;
    invariant(event.attempt >= priorAttempt, 'Provisioning attempt number regressed', 'PROVISIONING_EVENT_ATTEMPT_REGRESSION');
    attempts.set(event.stepCode, Math.max(priorAttempt, event.attempt));

    if (event.status === 'started') {
      invariant(!completed.has(event.stepCode), 'Completed provisioning step cannot restart', 'PROVISIONING_EVENT_RESTART_COMPLETED');
      activeStarted = { stepCode: event.stepCode, attempt: event.attempt };
      activeFailure = null;
    } else if (event.status === 'completed' || event.status === 'skipped') {
      invariant(event.attempt === (attempts.get(event.stepCode) || event.attempt), 'Completion attempt must be current');
      completed.add(event.stepCode);
      if (activeStarted?.stepCode === event.stepCode) activeStarted = null;
      if (activeFailure?.stepCode === event.stepCode) activeFailure = null;
    } else if (event.status === 'failed') {
      invariant(!completed.has(event.stepCode), 'Completed provisioning step cannot fail later', 'PROVISIONING_EVENT_FAIL_COMPLETED');
      activeFailure = { stepCode: event.stepCode, attempt: event.attempt, errorCode: event.errorCode || 'PROVISIONING_STEP_FAILED' };
      activeStarted = null;
    }
  }

  const firstIncompleteIndex = stepCodes.findIndex(code => !completed.has(code));
  if (firstIncompleteIndex === -1) {
    return Object.freeze({ status: 'completed', currentStepCode: null, nextAttempt: null, completedSteps: [...stepCodes], errorCode: null });
  }

  const currentStepCode = stepCodes[firstIncompleteIndex];
  const currentAttempt = attempts.get(currentStepCode) || 0;
  if (activeFailure?.stepCode === currentStepCode) {
    return Object.freeze({
      status: 'failed',
      currentStepCode,
      nextAttempt: currentAttempt + 1,
      completedSteps: stepCodes.filter(code => completed.has(code)),
      errorCode: activeFailure.errorCode
    });
  }

  return Object.freeze({
    status: 'running',
    currentStepCode,
    nextAttempt: activeStarted?.stepCode === currentStepCode ? currentAttempt : currentAttempt + 1,
    completedSteps: stepCodes.filter(code => completed.has(code)),
    errorCode: null
  });
}

module.exports = {
  canonicalize,
  manifestHash,
  createRunDescriptor,
  replayProvisioning
};
