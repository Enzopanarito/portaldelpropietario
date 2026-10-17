'use strict';

const { randomUUID } = require('node:crypto');
const { ACTIONS } = require('./access-policy-engine');

const ACTIONABLE = new Set([ACTIONS.ENABLE, ACTIONS.DISABLE]);

function auditEvent(action, executionId, decision, providerId, extra = {}) {
  return Object.freeze({
    action,
    entityType: 'access_credential',
    executionId,
    metadata: Object.freeze({
      provider: String(providerId || 'unknown'),
      requestedAction: decision.action,
      reasonCode: decision.reasonCode,
      desiredEnabled: decision.desiredEnabled,
      ...extra
    })
  });
}

async function writeAudit(auditWriter, event) {
  if (typeof auditWriter !== 'function') {
    throw Object.assign(new Error('auditWriter is required for live access commands'), { code: 'ACCESS_AUDIT_WRITER_REQUIRED' });
  }
  await auditWriter(event);
}

async function executeAccessDecision({
  decision,
  provider,
  externalCredentialId,
  email,
  auditWriter,
  dryRun = true,
  executionId = randomUUID()
} = {}) {
  if (!decision || typeof decision !== 'object' || !Object.values(ACTIONS).includes(decision.action)) {
    throw Object.assign(new Error('A valid access decision is required'), { code: 'ACCESS_DECISION_INVALID' });
  }

  if (!ACTIONABLE.has(decision.action)) {
    return Object.freeze({
      executionId,
      executed: false,
      dryRun: Boolean(dryRun),
      action: decision.action,
      reasonCode: decision.reasonCode,
      providerCalled: false
    });
  }

  if (!provider || typeof provider.setCredentialState !== 'function') {
    throw Object.assign(new Error('Access provider is required'), { code: 'ACCESS_PROVIDER_REQUIRED' });
  }
  if (typeof provider.supports === 'function' && !provider.supports('credential-state')) {
    throw Object.assign(new Error('Access provider does not support credential state changes'), { code: 'ACCESS_PROVIDER_CAPABILITY_MISSING' });
  }
  const credentialId = String(externalCredentialId || '').trim();
  if (!credentialId) {
    throw Object.assign(new Error('externalCredentialId is required'), { code: 'ACCESS_CREDENTIAL_ID_REQUIRED' });
  }

  if (dryRun) {
    return Object.freeze({
      executionId,
      executed: false,
      dryRun: true,
      action: decision.action,
      reasonCode: decision.reasonCode,
      desiredEnabled: decision.desiredEnabled,
      provider: provider.id || 'unknown',
      providerCalled: false
    });
  }

  const providerId = provider.id || 'unknown';
  await writeAudit(auditWriter, auditEvent('access.command.requested', executionId, decision, providerId));

  let result;
  try {
    result = await provider.setCredentialState({
      externalCredentialId: credentialId,
      enabled: decision.action === ACTIONS.ENABLE,
      email
    });
  } catch (error) {
    try {
      await writeAudit(auditWriter, auditEvent('access.command.failed', executionId, decision, providerId, {
        errorCode: String(error?.code || 'ACCESS_PROVIDER_FAILED')
      }));
    } catch (auditError) {
      error.auditFailure = auditError;
    }
    throw error;
  }

  try {
    await writeAudit(auditWriter, auditEvent('access.command.completed', executionId, decision, providerId, {
      providerStatus: result?.providerStatus ?? result?.status ?? null,
      idempotent: Boolean(result?.idempotent)
    }));
  } catch (error) {
    throw Object.assign(new Error('Hardware command succeeded but completion audit failed'), {
      code: 'ACCESS_COMPLETION_AUDIT_FAILED',
      cause: error,
      hardwareChanged: true,
      providerResult: result,
      executionId
    });
  }

  return Object.freeze({
    executionId,
    executed: true,
    dryRun: false,
    action: decision.action,
    reasonCode: decision.reasonCode,
    desiredEnabled: decision.desiredEnabled,
    provider: providerId,
    providerCalled: true,
    providerResult: result
  });
}

module.exports = {
  executeAccessDecision,
  auditEvent
};
