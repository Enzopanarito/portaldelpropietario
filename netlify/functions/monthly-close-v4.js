'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { requireAdmin, requireFreshAdmin } = require('./_shared/_auth');
const { buildPlan } = require('./_shared/_monthly_close_core_v4');
const {
  loadContext,
  listCloseMarkers,
  oldestLocked,
  acquireCloseLock,
  setCloseMarker,
  findOperationLog,
  parseOperationPayload
} = require('./_shared/_monthly_close_store_v5');
const { repairOperation } = require('./_shared/_monthly_close_repair');
const { executeClose } = require('./_shared/_monthly_close_execute');
const { isValidMonth, defaultDryRunMonth, closeWindowForMonth } = require('./_shared/_monthly_close_window');
const { validateSnapshotRecords } = require('./_shared/_monthly_close_snapshot');

function json(statusCode, body, counter = null) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, no-cache, must-revalidate' };
  if (counter) headers['X-Airtable-Calls'] = String(counter.calls || 0);
  return { statusCode, headers, body: JSON.stringify(body) };
}

function resolveMonth(rawValue, { allowDefault = true } = {}) {
  const raw = String(rawValue || '').trim();
  if (!raw) return allowDefault ? { ok:true, month:defaultDryRunMonth(), defaulted:true } : { ok:false, month:'', defaulted:false };
  if (!isValidMonth(raw)) return { ok:false, month:'', defaulted:false };
  return { ok:true, month:raw, defaulted:false };
}

function lockMessage(result, month) {
  if (result.status === 'in-progress' && result.stale === true) {
    return `El cierre de ${month} conserva un bloqueo antiguo sin resolución. Por seguridad no se ejecutará otro cierre hasta una recuperación administrativa explícita.`;
  }
  const messages = {
    'already-closed': `El mes ${month} ya fue cerrado. No se ejecutó nuevamente.`,
    'in-progress': `Ya existe un cierre de ${month} en proceso. Espere y actualice el panel.`,
    'partial-error': `Existe un cierre parcial de ${month}. Debe repararse antes de ejecutar otro cierre.`
  };
  return messages[result.status] || 'El cierre está protegido.';
}

function snapshotStatus(check) {
  if (check.complete) return 'complete';
  if (check.duplicates.length) return 'duplicate';
  if (check.unexpected.length) return 'unexpected';
  if (check.mismatched.length) return 'stale';
  return 'incomplete';
}

function validExecutedPlan(payload, done, month) {
  return !!(
    payload &&
    payload.kind === 'monthly-close-operation' &&
    payload.month === month &&
    payload.operationId === done?.operationId &&
    payload.plan &&
    payload.planHash &&
    payload.plan.planHash === payload.planHash
  );
}

async function historicalCertification({ done, month, context, livePlan, token, baseId, counter }) {
  if (!done) {
    const snapshot = validateSnapshotRecords(context.snapshotRecords || [], livePlan);
    return {
      snapshot,
      snapshotValidationMode: 'live-plan',
      closeCertification: null
    };
  }

  let log = null;
  let payload = null;
  try {
    log = await findOperationLog(month, done.operationId, token, baseId, counter);
    if (log) payload = parseOperationPayload(log);
  } catch (error) {
    return {
      snapshot: {
        complete:false,
        count:Number(context.snapshotRecords?.length || 0),
        expected:Number(context.owners?.length || 0) * 10,
        expectedHash:null,
        actualHash:null,
        missing:[],
        mismatched:[],
        duplicates:[],
        unexpected:[]
      },
      snapshotValidationMode:'historical-operation-error',
      closeCertification:{
        certified:false,
        operationId:done.operationId,
        historyStatus:'error',
        detail:String(error.message||error).slice(0,300)
      }
    };
  }

  if (!log || !validExecutedPlan(payload, done, month)) {
    return {
      snapshot: {
        complete:false,
        count:Number(context.snapshotRecords?.length || 0),
        expected:Number(context.owners?.length || 0) * 10,
        expectedHash:null,
        actualHash:null,
        missing:[],
        mismatched:[],
        duplicates:[],
        unexpected:[]
      },
      snapshotValidationMode:'historical-operation-missing',
      closeCertification:{
        certified:false,
        operationId:done.operationId,
        historyStatus:log?'invalid':'missing'
      }
    };
  }

  const snapshot = validateSnapshotRecords(context.snapshotRecords || [], payload.plan);
  const progress = payload.progress || {};
  const verification = payload.verification || {};
  const ownersVerified = progress.ownersVerified === true && (!Array.isArray(verification.ownerDifferences) || verification.ownerDifferences.length === 0);
  const paymentsVerified = progress.paymentsVerified === true && (!Array.isArray(verification.paymentDifferences) || verification.paymentDifferences.length === 0);
  const expectedPayments = Array.isArray(payload.plan.paymentIds) ? payload.plan.paymentIds.length : 0;
  const appliedPayments = Array.isArray(progress.paymentsApplied) ? new Set(progress.paymentsApplied).size : 0;
  const ownersExpected = Array.isArray(payload.plan.ownerUpdates) ? payload.plan.ownerUpdates.length : 0;
  const ownersApplied = Array.isArray(progress.ownersApplied) ? new Set(progress.ownersApplied).size : 0;
  const certified = snapshot.complete && ownersVerified && paymentsVerified && appliedPayments === expectedPayments && ownersApplied === ownersExpected;

  return {
    snapshot,
    snapshotValidationMode:'executed-plan',
    closeCertification:{
      certified,
      operationId:done.operationId,
      historyStatus:'verified',
      planHash:payload.planHash,
      sourceHash:payload.plan.sourceHash || null,
      operationState:payload.state || null,
      ownerCount:ownersExpected,
      ownersApplied,
      ownersVerified,
      paymentsCount:expectedPayments,
      paymentsApplied:appliedPayments,
      paymentsVerified,
      snapshotHash:snapshot.actualHash,
      snapshotExpectedHash:snapshot.expectedHash,
      snapshotComplete:snapshot.complete,
      completedAt:payload.completedAt || null
    }
  };
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' }, counter);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { success:false, message:'Solicitud JSON inválida.' }, counter); }

  const dryRun = body.dryRun === true;
  if (!dryRun || body.action === 'repair') {
    const fresh = requireFreshAdmin(event);
    if (!fresh.ok) return fresh.response;
  }
  const monthResult = resolveMonth(body.month, { allowDefault:dryRun });
  if (!monthResult.ok) {
    return json(400, { success:false, protected:true, invalidMonth:true, message:'Debe indicar un mes válido con formato YYYY-MM.' }, counter);
  }
  const month = monthResult.month;

  if (body.action === 'repair') {
    return repairOperation({ month, operationId: String(body.operationId || '').trim(), token: AIRTABLE_API_TOKEN, baseId: AIRTABLE_BASE_ID, counter, json });
  }

  if (!dryRun && body.confirmed !== true) return json(400, { message: 'Debe confirmar explícitamente el cierre de mes.' }, counter);

  if (dryRun) {
    try {
      const context = await loadContext(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      if (!context.owners.length) throw new Error('No se encontraron propietarios para cerrar el mes.');
      const plan = buildPlan({ owners:context.owners, expenses:context.expenses, payments:context.payments, month, dueDay:context.automationRules?.payment?.dueDay, surchargeRate:context.automationRules?.payment?.surchargeRate });
      const window = closeWindowForMonth(month);
      const markers = await listCloseMarkers(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      const done = markers.find(marker => marker.status === 'DONE');
      const partial = markers.find(marker => marker.status === 'ERROR_PARTIAL');
      const running = oldestLocked(markers);
      const certification = await historicalCertification({
        done,
        month,
        context,
        livePlan:plan,
        token:AIRTABLE_API_TOKEN,
        baseId:AIRTABLE_BASE_ID,
        counter
      });
      const snapshot = certification.snapshot;
      const paymentScopeReady = plan.validation?.closeScopeReady !== false;
      const canExecute = !done && !partial && !running && paymentScopeReady && snapshot.complete && window.ok;
      const closeStatus = done ? 'already-closed'
        : partial ? 'partial-error'
          : running ? 'in-progress'
            : !paymentScopeReady ? 'blocked-invalid-payment-dates'
              : !snapshot.complete ? `blocked-snapshot-${snapshotStatus(snapshot)}`
                : !window.ok ? 'blocked-outside-close-window'
                  : 'ready';
      return json(200, {
        success:true,
        dryRun:true,
        month,
        monthDefaulted:monthResult.defaulted,
        // Para un mes ya cerrado, planHash representa el plan que realmente se
        // ejecutó. currentPlanHash conserva la recomputación diagnóstica actual.
        planHash:done && certification.closeCertification?.planHash ? certification.closeCertification.planHash : plan.planHash,
        currentPlanHash:plan.planHash,
        sourceHash:done && certification.closeCertification?.sourceHash ? certification.closeCertification.sourceHash : plan.sourceHash,
        currentSourceHash:plan.sourceHash,
        validation:plan.validation,
        ownerPlan:plan.ownerUpdates,
        snapshot,
        snapshotValidationMode:certification.snapshotValidationMode,
        closeCertification:certification.closeCertification,
        closeWindow:window,
        closeStatus,
        staleLock:running?.stale === true,
        requiresRecovery:running?.stale === true,
        lockOperationId:running?.operationId || null,
        lockAgeMs:running?.ageMs ?? null,
        repairAvailable:!!partial,
        repairOperationId:partial?.operationId || null,
        canExecute
      }, counter);
    } catch (error) {
      return json(500, { success:false, dryRun:true, message:'Error preparando la simulación del cierre.', detail:error.message }, counter);
    }
  }

  const window = closeWindowForMonth(month);
  if (!window.ok) {
    return json(409, {
      success:false,
      protected:true,
      outsideCloseWindow:true,
      month,
      closeWindow:window,
      message:window.message
    }, counter);
  }

  const submittedPlanHash = String(body.planHash || '').trim();
  if (!/^[a-f0-9]{64}$/.test(submittedPlanHash)) {
    return json(400, { success:false, protected:true, message:'La simulación no tiene una huella válida. Vuelva a simular.' }, counter);
  }

  let closeLock = null;
  let handedOff = false;
  try {
    const lockResult = await acquireCloseLock(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!lockResult.ok) {
      return json(409, {
        success:false,
        protected:true,
        closeStatus:lockResult.status,
        staleLock:lockResult.stale === true,
        requiresRecovery:lockResult.requiresRecovery === true,
        lockAgeMs:lockResult.marker?.ageMs ?? null,
        month,
        repairAvailable:lockResult.status==='partial-error',
        repairOperationId:lockResult.marker?.operationId||null,
        message:lockMessage(lockResult,month)
      }, counter);
    }
    closeLock = lockResult.marker;
    const context = await loadContext(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!context.owners.length) throw new Error('No se encontraron propietarios para cerrar el mes.');
    const plan = buildPlan({ owners:context.owners, expenses:context.expenses, payments:context.payments, month, dueDay:context.automationRules?.payment?.dueDay, surchargeRate:context.automationRules?.payment?.surchargeRate });

    if (plan.validation?.closeScopeReady === false) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      return json(409, { success:false, protected:true, month, invalidPaymentDatesCount:plan.validation.invalidPaymentDatesCount, invalidPaymentIds:plan.validation.invalidPaymentIds, message:'Existen pagos sin una fecha válida. El cierre se detuvo sin modificar datos.' }, counter);
    }

    if (plan.planHash !== submittedPlanHash) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      return json(409, { success:false, protected:true, staleSimulation:true, month, newPlanHash:plan.planHash, message:'Los pagos, gastos o saldos cambiaron después de la simulación. No se modificó nada. Vuelva a simular.' }, counter);
    }

    const snapshot = validateSnapshotRecords(context.snapshotRecords || [], plan);
    if (!snapshot.complete) {
      await setCloseMarker(closeLock, month, 'ABORTED', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
      return json(409, {
        success:false,
        protected:true,
        snapshotIncomplete:true,
        snapshotStatus:snapshotStatus(snapshot),
        month,
        snapshot,
        message:`El corte de auditoría no coincide exactamente con el plan (${snapshot.count}/${snapshot.expected}). No se modificó nada.`
      }, counter);
    }

    handedOff = true;
    return executeClose({ month, closeLock, plan, context:Object.assign({}, context, { snapshotCount:snapshot.count, expectedSnapshotCount:snapshot.expected, snapshotComplete:true }), token:AIRTABLE_API_TOKEN, baseId:AIRTABLE_BASE_ID, counter, json });
  } catch (error) {
    if (closeLock && !handedOff) await setCloseMarker(closeLock, month, 'ERROR_SAFE', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
    return json(500, { success:false, protected:true, month, message:'Error preparando la ejecución del cierre. No se aplicaron cambios.', detail:error.message }, counter);
  }
};

exports.handler = withAirtableUsage('monthly-close-v4', handler);
exports.validExecutedPlan = validExecutedPlan;
exports.historicalCertification = historicalCertification;
