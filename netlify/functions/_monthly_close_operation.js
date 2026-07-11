'use strict';

const { createOperationLog, updateOperationLog } = require('./_monthly_close_store');

function newPayload(month, operationId, plan, context) {
  return {
    version: 3,
    kind: 'monthly-close-operation',
    operationId,
    month,
    planHash: plan.planHash,
    state: 'PREPARED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    snapshot: { count: context.snapshotCount, expected: context.expectedSnapshotCount, complete: context.snapshotComplete },
    plan,
    progress: {
      ownersApplied: [],
      paymentsApplied: [],
      ownersVerified: false,
      paymentsVerified: false,
      restoreAttempted: false,
      restoreVerified: false
    },
    accessSync: null,
    errors: []
  };
}

async function createPreparedLog(month, marker, plan, context, token, baseId, counter) {
  const payload = newPayload(month, marker.operationId, plan, context);
  const log = await createOperationLog(payload, token, baseId, counter);
  if (!log?.id) throw new Error('No se pudo crear la bitácora previa al cierre.');
  return { payload, log };
}

async function persistProgress(logId, payload, token, baseId, counter, stateChoice = 'Simulación') {
  payload.updatedAt = new Date().toISOString();
  await updateOperationLog(logId, payload, stateChoice, token, baseId, counter);
}

module.exports = { newPayload, createPreparedLog, persistProgress };
