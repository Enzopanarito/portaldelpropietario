'use strict';

const { begin, setState } = require('./_operation_guard');
const { restorePlan } = require('./_monthly_close_verify');
const { persistProgress } = require('./_monthly_close_operation');
const {
  findOperationLog,
  parseOperationPayload,
  listCloseMarkers,
  setCloseMarker
} = require('./_monthly_close_store');

const VALID_OPERATION_ID = /^[A-Za-z0-9_-]{8,120}$/;

async function repairOperation({ month, operationId, token, baseId, counter, json }) {
  if (!VALID_OPERATION_ID.test(operationId)) return json(400, { success: false, message: 'Identificador de operación inválido.' }, counter);
  const log = await findOperationLog(month, operationId, token, baseId, counter);
  if (!log) return json(404, { success: false, message: 'No se encontró la bitácora del cierre parcial.' }, counter);
  const payload = parseOperationPayload(log);
  if (!payload.plan || payload.month !== month || payload.operationId !== operationId) {
    return json(409, { success: false, protected: true, message: 'La bitácora no coincide con la operación solicitada.' }, counter);
  }

  const key = `${month}|${operationId}`;
  const guard = await begin('MONTHLY_CLOSE_REPAIR', key);
  if (!guard.ok) {
    return json(guard.reason === 'done' ? 200 : 409, {
      success: guard.reason === 'done',
      protected: true,
      message: guard.reason === 'done' ? 'Esta reparación ya había terminado.' : 'La reparación ya está en curso o requiere revisión.'
    }, counter);
  }

  try {
    payload.state = 'REPAIRING';
    payload.progress = payload.progress || {};
    payload.progress.restoreAttempted = true;
    await persistProgress(log.id, payload, token, baseId, counter, 'Error');
    const restoration = await restorePlan(payload.plan, token, baseId, counter);
    payload.restoration = restoration;
    payload.progress.restoreVerified = restoration.ok;
    payload.state = restoration.ok ? 'RESTORED' : 'ERROR_PARTIAL';
    if (!restoration.ok) payload.errors = [...(payload.errors || []), { at: new Date().toISOString(), message: 'La reparación no pudo verificarse.', detail: restoration }];
    await persistProgress(log.id, payload, token, baseId, counter, 'Error');

    const markers = await listCloseMarkers(month, token, baseId, counter);
    const marker = markers.find(item => item.operationId === operationId);
    if (marker) await setCloseMarker(marker, month, restoration.ok ? 'ERROR_SAFE' : 'ERROR_PARTIAL', token, baseId, counter);
    await setState(guard.marker, 'MONTHLY_CLOSE_REPAIR', key, restoration.ok ? 'DONE' : 'PARTIAL', operationId).catch(() => null);

    return json(restoration.ok ? 200 : 409, {
      success: restoration.ok,
      protected: true,
      repaired: restoration.ok,
      operationId,
      message: restoration.ok
        ? 'El cierre parcial fue restaurado y verificado. Ya puede simular nuevamente.'
        : 'La reparación detectó diferencias y se detuvo para no sobrescribir información.',
      restoration
    }, counter);
  } catch (error) {
    await setState(guard.marker, 'MONTHLY_CLOSE_REPAIR', key, 'PARTIAL', operationId).catch(() => null);
    return json(500, { success: false, protected: true, operationId, message: 'La reparación se interrumpió y requiere revisión.', detail: error.message }, counter);
  }
}

module.exports = { repairOperation };
