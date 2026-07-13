'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const { requireAdmin } = require('./_auth');
const { buildPlan } = require('./_monthly_close_core');
const { ACTIVE_LOCK_TTL_MS, loadContext, listCloseMarkers, acquireCloseLock, setCloseMarker } = require('./_monthly_close_store');
const { repairOperation } = require('./_monthly_close_repair');
const { executeClose } = require('./_monthly_close_execute');
const {
  beginMonthlyClose,
  finalizeMonthlyClose,
  releaseMonthlyClose,
  blockMonthlyClose
} = require('./_monthly_close_idempotency');

function json(statusCode, body, counter = null) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' };
  if (counter) headers['X-Airtable-Calls'] = String(counter.calls || 0);
  return { statusCode, headers, body: JSON.stringify(body) };
}
function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}
function normalizeMonth(value) {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonthCaracas();
}
function lockMessage(result, month) {
  const messages = {
    'already-closed': `El mes ${month} ya fue cerrado. No se ejecutó nuevamente.`,
    'in-progress': `Ya existe un cierre de ${month} en proceso. Espere y actualice el panel.`,
    'partial-error': `Existe un cierre parcial de ${month}. Debe repararse antes de ejecutar otro cierre.`
  };
  return messages[result.status] || 'El cierre está protegido.';
}
function atomicResponse(result, month, counter) {
  if (result.reason === 'done') {
    return json(200, {
      success:true,
      protected:true,
      idempotent:true,
      closeStatus:'already-closed',
      month,
      closeOperationId:result.result?.closeOperationId||null,
      message:`El mes ${month} ya fue cerrado por esta operación. No se ejecutó nuevamente.`
    }, counter);
  }
  if (result.reason === 'partial') {
    return json(409, {
      success:false,
      protected:true,
      partial:true,
      closeStatus:'partial-error',
      month,
      repairAvailable:true,
      repairOperationId:result.result?.repairOperationId||result.result?.closeOperationId||null,
      message:`Existe un cierre parcial de ${month}. Debe revisarse o repararse antes de otro intento.`
    }, counter);
  }
  if (result.reason === 'conflict') {
    return json(409, {
      success:false,
      protected:true,
      idempotencyConflict:true,
      staleSimulation:true,
      month,
      message:'La misma operación mensual ya fue utilizada con otra huella financiera. Vuelva a simular y revise el estado del cierre.'
    }, counter);
  }
  return json(409, {
    success:false,
    protected:true,
    closeStatus:'in-progress',
    month,
    message:`Ya existe un cierre atómico de ${month} en proceso. Espere y actualice el panel.`
  }, counter);
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' }, counter);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const month = normalizeMonth(body.month);
  if (body.action === 'repair') {
    return repairOperation({ month, operationId: String(body.operationId || '').trim(), token: AIRTABLE_API_TOKEN, baseId: AIRTABLE_BASE_ID, counter, json });
  }

  const dryRun = body.dryRun === true;
  if (!dryRun && body.confirmed !== true) return json(400, { message: 'Debe confirmar explícitamente el cierre de mes.' }, counter);

  if (dryRun) {
    try {
      const context = await loadContext(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      if (!context.owners.length) throw new Error('No se encontraron propietarios para cerrar el mes.');
      const plan = buildPlan({ owners: context.owners, expenses: context.expenses, payments: context.payments, month });
      const markers = await listCloseMarkers(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      const done = markers.find(marker => marker.status === 'DONE');
      const partial = markers.find(marker => marker.status === 'ERROR_PARTIAL');
      const cutoff = Date.now() - ACTIVE_LOCK_TTL_MS;
      const running = markers.find(marker => marker.status === 'LOCKED' && (!Number.isFinite(marker.createdAt) || marker.createdAt >= cutoff));
      return json(200, {
        success: true,
        dryRun: true,
        month,
        planHash: plan.planHash,
        sourceHash: plan.sourceHash,
        validation: plan.validation,
        snapshot: { count: context.snapshotCount, expected: context.expectedSnapshotCount, complete: context.snapshotComplete },
        closeStatus: done ? 'already-closed' : partial ? 'partial-error' : running ? 'in-progress' : 'ready',
        repairAvailable: !!partial,
        repairOperationId: partial?.operationId || null,
        canExecute: !done && !partial && !running
      }, counter);
    } catch (error) {
      return json(500, { success: false, dryRun: true, message: 'Error preparando la simulación del cierre.', detail: error.message }, counter);
    }
  }

  const submittedPlanHash = String(body.planHash || '').trim();
  if (!/^[a-f0-9]{64}$/.test(submittedPlanHash)) {
    return json(400, { success: false, protected: true, message: 'La simulación no tiene una huella válida. Vuelva a simular.' }, counter);
  }

  let atomicClose = null;
  let closeLock = null;
  let handedOff = false;
  try {
    atomicClose = await beginMonthlyClose(month, submittedPlanHash);
    if (!atomicClose.ok) return atomicResponse(atomicClose, month, counter);

    const lockResult = await acquireCloseLock(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!lockResult.ok) {
      const response = json(lockResult.status === 'already-closed' ? 200 : 409, {
        success: lockResult.status === 'already-closed',
        protected: true,
        closeStatus: lockResult.status,
        month,
        repairAvailable: lockResult.status === 'partial-error',
        repairOperationId: lockResult.marker?.operationId || null,
        closeOperationId: lockResult.marker?.operationId || null,
        message: lockMessage(lockResult, month)
      }, counter);
      if (lockResult.status === 'already-closed') return finalizeMonthlyClose(atomicClose, response, month);
      if (lockResult.status === 'partial-error') {
        await blockMonthlyClose(atomicClose, 'AIRTABLE_CLOSE_PARTIAL', { month, repairOperationId:lockResult.marker?.operationId||'' });
        return response;
      }
      await releaseMonthlyClose(atomicClose, 'AIRTABLE_CLOSE_IN_PROGRESS', { month });
      return response;
    }

    closeLock = lockResult.marker;
    const context = await loadContext(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!context.owners.length) throw new Error('No se encontraron propietarios para cerrar el mes.');
    const plan = buildPlan({ owners: context.owners, expenses: context.expenses, payments: context.payments, month });

    if (plan.planHash !== submittedPlanHash) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      await releaseMonthlyClose(atomicClose, 'STALE_SIMULATION', { month, submittedPlanHash, currentPlanHash:plan.planHash });
      return json(409, { success: false, protected: true, staleSimulation: true, month, newPlanHash: plan.planHash, message: 'Los pagos, gastos o saldos cambiaron después de la simulación. No se modificó nada. Vuelva a simular.' }, counter);
    }
    if (!context.snapshotComplete) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      await releaseMonthlyClose(atomicClose, 'SNAPSHOT_INCOMPLETE', { month, snapshotCount:context.snapshotCount, expectedSnapshotCount:context.expectedSnapshotCount });
      return json(409, {
        success: false,
        protected: true,
        snapshotIncomplete: true,
        month,
        snapshotCount: context.snapshotCount,
        expectedSnapshotCount: context.expectedSnapshotCount,
        message: `El corte de auditoría está incompleto (${context.snapshotCount}/${context.expectedSnapshotCount}). No se modificó nada.`
      }, counter);
    }

    handedOff = true;
    const response = await executeClose({ month, closeLock, plan, context, token: AIRTABLE_API_TOKEN, baseId: AIRTABLE_BASE_ID, counter, json });
    return finalizeMonthlyClose(atomicClose, response, month);
  } catch (error) {
    if (closeLock && !handedOff) await setCloseMarker(closeLock, month, 'ERROR_SAFE', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
    if (atomicClose?.ok) {
      if (handedOff) await blockMonthlyClose(atomicClose, 'EXECUTOR_THROWN_UNCERTAIN', { month, closeOperationId:closeLock?.operationId||'', detail:String(error.message||'').slice(0,300) }).catch(() => null);
      else await releaseMonthlyClose(atomicClose, 'PREPARE_THROWN', { month }).catch(() => null);
    }
    return json(handedOff ? 409 : 500, {
      success:false,
      protected:true,
      partial:handedOff,
      repairAvailable:handedOff,
      repairOperationId:handedOff ? closeLock?.operationId||null : null,
      month,
      message:handedOff
        ? 'El ejecutor del cierre devolvió un error inesperado después de recibir la operación. El mes quedó bloqueado para revisión; no repita el cierre.'
        : 'Error preparando la ejecución del cierre. No se aplicaron cambios.',
      detail:error.message
    }, counter);
  }
};

exports.handler = withAirtableUsage('monthly-close-v2', handler);
