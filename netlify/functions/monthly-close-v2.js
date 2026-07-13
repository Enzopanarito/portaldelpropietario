'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const { requireAdmin } = require('./_auth');
const { buildPlan } = require('./_monthly_close_core');
const { ACTIVE_LOCK_TTL_MS, loadContext, listCloseMarkers, acquireCloseLock, setCloseMarker } = require('./_monthly_close_store');
const { repairOperation } = require('./_monthly_close_repair');
const { executeClose } = require('./_monthly_close_execute');
const { assertSafeAirtableContext, isolationResponse } = require('./_environment_guard');

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

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
  try { assertSafeAirtableContext({ write:true, allowUnclassified:true }); }
  catch (error) { return isolationResponse(error); }

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

  let closeLock = null;
  let handedOff = false;
  try {
    const lockResult = await acquireCloseLock(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!lockResult.ok) {
      return json(409, {
        success: false,
        protected: true,
        closeStatus: lockResult.status,
        month,
        repairAvailable: lockResult.status === 'partial-error',
        repairOperationId: lockResult.marker?.operationId || null,
        message: lockMessage(lockResult, month)
      }, counter);
    }

    closeLock = lockResult.marker;
    const context = await loadContext(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!context.owners.length) throw new Error('No se encontraron propietarios para cerrar el mes.');
    const plan = buildPlan({ owners: context.owners, expenses: context.expenses, payments: context.payments, month });

    if (plan.planHash !== submittedPlanHash) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      return json(409, { success: false, protected: true, staleSimulation: true, month, newPlanHash: plan.planHash, message: 'Los pagos, gastos o saldos cambiaron después de la simulación. No se modificó nada. Vuelva a simular.' }, counter);
    }
    if (!context.snapshotComplete) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
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
    return await executeClose({ month, closeLock, plan, context, token: AIRTABLE_API_TOKEN, baseId: AIRTABLE_BASE_ID, counter, json });
  } catch (error) {
    if (closeLock && !handedOff) await setCloseMarker(closeLock, month, 'ERROR_SAFE', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
    return json(500, { success: false, protected: true, month, message: 'Error preparando la ejecución del cierre. No se aplicaron cambios.', detail: error.message }, counter);
  }
};

exports.handler = withAirtableUsage('monthly-close-v2', handler);
