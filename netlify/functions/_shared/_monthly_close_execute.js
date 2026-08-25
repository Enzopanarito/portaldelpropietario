'use strict';

const { autoSyncAll } = require('./_access_control');
const { debtFields } = require('./_monthly_close_core');
const { TABLES, patchBatches, setCloseMarker, createRecord, closeKey } = require('./_monthly_close_store');
const { createPreparedLog, persistProgress } = require('./_monthly_close_operation');
const { verifyPlan, restorePlan } = require('./_monthly_close_verify');
const { rotateExpenses, syncRecurringPreloads } = require('./_expense_lifecycle_store');
const { nextMonth } = require('./_expense_lifecycle');

async function executeClose({ month, closeLock, plan, context, token, baseId, counter, json }) {
  let operationLog = null;
  let payload = null;
  let dataCompleted = false;

  try {
    const prepared = await createPreparedLog(month, closeLock, plan, context, token, baseId, counter);
    payload = prepared.payload;
    operationLog = prepared.log;

    const ownerRecords = plan.ownerUpdates.map(item => ({ id: item.id, fields: debtFields(item.target) }));
    payload.state = 'OWNERS_IN_PROGRESS';
    await persistProgress(operationLog.id, payload, token, baseId, counter);
    await patchBatches(TABLES.owners, ownerRecords, token, baseId, counter, async batch => {
      payload.progress.ownersApplied.push(...batch.map(record => record.id));
      await persistProgress(operationLog.id, payload, token, baseId, counter);
    });
    payload.state = 'OWNERS_APPLIED';
    await persistProgress(operationLog.id, payload, token, baseId, counter);

    const paymentRecords = plan.paymentIds.map(id => ({ id, fields: { '[x] Aplicado al Cierre': true } }));
    payload.state = 'PAYMENTS_IN_PROGRESS';
    await persistProgress(operationLog.id, payload, token, baseId, counter);
    await patchBatches(TABLES.payments, paymentRecords, token, baseId, counter, async batch => {
      payload.progress.paymentsApplied.push(...batch.map(record => record.id));
      await persistProgress(operationLog.id, payload, token, baseId, counter);
    });
    payload.state = 'PAYMENTS_APPLIED';
    await persistProgress(operationLog.id, payload, token, baseId, counter);

    const verification = await verifyPlan(plan, 'target', token, baseId, counter);
    payload.verification = verification;
    payload.progress.ownersVerified = verification.ownerDifferences.length === 0;
    payload.progress.paymentsVerified = verification.paymentDifferences.length === 0;
    if (!verification.ok) throw new Error('La verificación posterior al cierre detectó diferencias.');
    payload.state = 'VERIFIED';
    await persistProgress(operationLog.id, payload, token, baseId, counter);

    // El cierre financiero queda confirmado antes de cualquier integración
    // externa. Si MKJ está temporalmente caído, el cierre permanece válido y
    // el piloto puede reintentar el portón sin repetir cargos ni pagos.
    let markerWarning = null;
    try { await setCloseMarker(closeLock, month, 'DONE', token, baseId, counter); }
    catch (error) {
      markerWarning = `No se pudo finalizar el marcador: ${error.message}`;
      try {
        await createRecord(TABLES.control, { Key: closeKey(month, 'DONE', closeLock.operationId), Version: 2 }, token, baseId, counter);
        markerWarning = null;
      } catch (_) {}
    }
    if (markerWarning) throw new Error(markerWarning);
    dataCompleted = true;
    payload.state = 'ACCOUNTING_COMPLETED';
    await persistProgress(operationLog.id, payload, token, baseId, counter).catch(() => null);

    const activatedMonth=nextMonth(month),futureMonth=nextMonth(activatedMonth);
    let expenseRotation = null,expensePreload=null;
    try {
      expenseRotation = await rotateExpenses({ closingMonth:month, targetMonth:activatedMonth, token, baseId, counter });
      // Una vez activado el nuevo mes, dejamos preparado el siguiente de inmediato.
      // Esto ya no depende de que el piloto diario coincida con una ventana de fechas.
      expensePreload = await syncRecurringPreloads({closingMonth:activatedMonth,targetMonth:futureMonth,token,baseId,counter,scope:'EXPENSE_POST_CLOSE_PRELOAD'});
    } catch (error) {
      if(!expenseRotation?.success)expenseRotation = { success:false, error:error.message, retryable:true };
      else expensePreload = { success:false, error:error.message, retryable:true };
    }
    payload.expenseRotation = expenseRotation;
    payload.expensePreload = expensePreload;

    let accessSync = null;
    try { accessSync = await autoSyncAll({ forceMkj: true, sendEmail: true }); }
    catch (error) { accessSync = { success: false, error: error.message }; }
    payload.accessSync = accessSync;
    payload.state = 'COMPLETED';
    payload.completedAt = new Date().toISOString();

    let logWarning = null;
    try { await persistProgress(operationLog.id, payload, token, baseId, counter, 'Ejecutado'); }
    catch (error) { logWarning = `No se pudo finalizar la bitácora: ${error.message}`; }

    const accessErrors = Number(accessSync?.errors || 0);
    const accessWarning = accessSync?.success === false || accessErrors > 0;
    const rotationWarning = expenseRotation?.success === false;
    const preloadWarning = expensePreload?.success === false;
    return json(200, {
      success: true,
      month,
      closeOperationId: closeLock.operationId,
      planHash: plan.planHash,
      updatedCount: plan.ownerUpdates.length,
      paymentsClosedCount: plan.paymentIds.length,
      validation: plan.validation,
      verification,
      expenseRotation,
      expensePreload,
      accessSync,
      warning: logWarning || (rotationWarning ? 'El cierre contable terminó, pero la rotación de gastos debe reintentarse.' : null) || (preloadWarning ? 'El cierre contable terminó, pero la precarga recurrente del mes posterior debe reintentarse.' : null) || (accessWarning ? 'El cierre contable terminó, pero uno o más accesos requieren revisión.' : null),
      message: rotationWarning
        ? 'Cierre mensual completado y verificado. La activación de gastos del nuevo mes quedó en reintento seguro.'
        : preloadWarning
        ? 'Cierre mensual completado y verificado. Los gastos del nuevo mes se activaron, pero la siguiente precarga recurrente quedó en reintento seguro.'
        : accessWarning
        ? 'Cierre mensual completado y verificado. La sincronización del portón terminó con advertencias.'
        : 'Cierre mensual completado, verificado, con recurrencias futuras preparadas y sincronizado con el portón.'
    }, counter);
  } catch (error) {
    if (dataCompleted) {
      return json(200, {
        success: true,
        month,
        closeOperationId: closeLock?.operationId || null,
        warning: 'Los datos del cierre quedaron completos, pero falló una tarea de finalización. No repita el cierre.',
        detail: error.message
      }, counter);
    }

    let restoration = null;
    if (operationLog?.id && plan) {
      try {
        payload.state = 'RESTORING';
        payload.progress.restoreAttempted = true;
        payload.errors.push({ at: new Date().toISOString(), message: error.message });
        await persistProgress(operationLog.id, payload, token, baseId, counter, 'Error');
        restoration = await restorePlan(plan, token, baseId, counter);
        payload.restoration = restoration;
        payload.progress.restoreVerified = restoration.ok;
        payload.state = restoration.ok ? 'RESTORED' : 'ERROR_PARTIAL';
        await persistProgress(operationLog.id, payload, token, baseId, counter, 'Error');
      } catch (restoreError) {
        restoration = { ok: false, error: restoreError.message };
        if (payload) {
          payload.state = 'ERROR_PARTIAL';
          payload.errors = [...(payload.errors || []), { at: new Date().toISOString(), message: restoreError.message }];
          await persistProgress(operationLog.id, payload, token, baseId, counter, 'Error').catch(() => null);
        }
      }
    }

    const safe = !operationLog || restoration?.ok === true;
    await setCloseMarker(closeLock, month, safe ? 'ERROR_SAFE' : 'ERROR_PARTIAL', token, baseId, counter).catch(() => null);
    return json(safe ? 500 : 409, {
      success: false,
      month,
      protected: true,
      partial: !safe,
      restored: restoration?.ok === true,
      repairAvailable: !safe,
      repairOperationId: !safe ? closeLock.operationId : null,
      message: restoration?.ok
        ? 'El cierre se interrumpió, pero todos los cambios fueron restaurados y verificados. Puede volver a simular.'
        : operationLog
          ? 'El cierre se interrumpió y la restauración no pudo verificarse. Use la reparación protegida.'
          : 'El cierre falló antes de modificar datos contables.',
      detail: error.message,
      restoration
    }, counter);
  }
}

module.exports = { executeClose };
