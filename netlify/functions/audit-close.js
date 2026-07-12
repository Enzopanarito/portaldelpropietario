require('./_airtable_usage_meter').install('audit-close');

// netlify/functions/audit-close.js
// Archiva y limpia pagos antiguos ya aplicados al cierre sin alterar saldos operativos.
// Estrategia: archivo verificable -> consolidado equivalente -> eliminación -> verificación por casa.

'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_auth');
const { begin, setState } = require('./_operation_guard');
const { safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const {
  CONSOLIDATED_FLAG_FIELD,
  AUDIT_OPERATION_FIELD,
  money,
  selectName,
  ownerFingerprint,
  compareFingerprints,
  hashJson,
  buildPlan,
  aggregateFields,
  originalWritableFields
} = require('./_audit_cleanup');

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  recibos: 'Recibos de Pago',
  historial: 'Historial de Cargos',
  cierres: 'Cierres de Auditoría',
  control: 'ControlVersiones'
};

const OWNER_FIELDS = [
  'Propietario', 'Casa', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Anterior Bs Ref',
  'Total Pagado', 'Deuda Restante', 'Recargo Aplicado',
  'Estado Acceso Portón', 'Motivo Limitación Acceso'
];
const PAYMENT_FIELDS = [
  'ID de Pago', 'Propietario que Paga', 'Monto Pagado', 'Fecha de Pago', 'Método de Pago',
  '[x] Aplicado al Cierre', 'Forma de Pago', 'Monto Pagado Bs', 'Tasa BCV Aplicada',
  'Equivalente USD Aplicado', CONSOLIDATED_FLAG_FIELD, AUDIT_OPERATION_FIELD
];
const RECEIPT_FIELDS = [
  'Nro Recibo', 'Pago', 'Casa', 'Fecha', 'Monto USD', 'Monto Bs', 'Forma de Pago',
  'Referencia', 'Correo', 'Estado Email', 'Enviado En', 'Log'
];

const CONFIRM_TEXT = 'ARCHIVAR_Y_LIMPIAR';
const ARCHIVE_CHUNK_SIZE = 20;
const VERIFY_ATTEMPTS = 8;
const VERIFY_WAIT_MS = 450;

function json(statusCode, body, counter = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  };
  if (counter) headers['X-Airtable-Calls'] = String(counter.calls || 0);
  return { statusCode, headers, body: JSON.stringify(body) };
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

function withFields(query, fields) {
  const params = [];
  for (const name of fields || []) params.push('fields%5B%5D=' + encodeURIComponent(name));
  if (!params.length) return query || '';
  if (!query) return '?' + params.join('&');
  return query + (query.includes('?') && query.length > 1 ? '&' : '?') + params.join('&');
}

async function request(url, options, counter) {
  counter.calls += 1;
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || `Error Airtable HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function getAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';
  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, safeQuery + (offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''));
    const data = await request(url, { headers: { Authorization: `Bearer ${token}` } }, counter);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function getRecord(tableName, recordId, token, baseId, counter) {
  return request(buildUrl(baseId, tableName, '/' + encodeURIComponent(recordId)), {
    headers: { Authorization: `Bearer ${token}` }
  }, counter);
}

async function createRecords(tableName, records, token, baseId, counter) {
  const created = [];
  for (let index = 0; index < records.length; index += 10) {
    const batch = records.slice(index, index + 10);
    if (!batch.length) continue;
    const data = await request(buildUrl(baseId, tableName), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    }, counter);
    created.push(...(data.records || []));
  }
  return created;
}

async function patchRecords(tableName, records, token, baseId, counter) {
  const updated = [];
  for (let index = 0; index < records.length; index += 10) {
    const batch = records.slice(index, index + 10);
    if (!batch.length) continue;
    const data = await request(buildUrl(baseId, tableName), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    }, counter);
    updated.push(...(data.records || []));
  }
  return updated;
}

async function deleteRecords(tableName, ids, token, baseId, counter) {
  const deletedIds = [];
  try {
    for (let index = 0; index < ids.length; index += 10) {
      const batch = ids.slice(index, index + 10);
      if (!batch.length) continue;
      const query = '?' + batch.map(id => 'records%5B%5D=' + encodeURIComponent(id)).join('&');
      const data = await request(buildUrl(baseId, tableName, query), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }, counter);
      for (const record of data.records || []) if (record.deleted) deletedIds.push(record.id);
    }
    return deletedIds;
  } catch (error) {
    error.deletedIds = deletedIds;
    throw error;
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function monthCaracas() {
  return todayCaracasISO().slice(0, 7);
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : monthCaracas();
}

function parseRetentionDays(value) {
  const number = parseInt(value || '180', 10);
  if (!Number.isFinite(number)) return 180;
  return Math.min(Math.max(number, 90), 730);
}

function cutoffISO(retentionDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - retentionDays);
  return date.toISOString().slice(0, 10);
}

function operationId() {
  return `AUD-${todayCaracasISO().replace(/-/g, '')}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function blockedPaymentIds(controlRecords) {
  const blocked = new Set();
  for (const record of controlRecords || []) {
    const key = String(record.fields?.Key || '');
    if (!key.startsWith('FIN_OP|')) continue;
    const parts = key.split('|');
    const state = parts[3] || '';
    const resultId = parts[5] || '';
    if ((state === 'RUNNING' || state === 'PARTIAL') && /^rec[A-Za-z0-9]{14}$/.test(resultId)) blocked.add(resultId);
  }
  return blocked;
}

function summarizePlan(plan, owners) {
  const ownersById = new Map(owners.map(owner => [owner.id, owner]));
  const byOwner = new Map();
  for (const group of plan.groups) {
    if (!byOwner.has(group.ownerId)) {
      const fingerprint = ownerFingerprint(ownersById.get(group.ownerId));
      byOwner.set(group.ownerId, {
        ownerId: group.ownerId,
        casa: group.casa,
        propietario: group.propietario,
        pagosAEliminar: 0,
        registrosConsolidados: 0,
        montoIdentificado: 0,
        deudaAnteriorAntes: fingerprint.deudaAnterior,
        deudaAnteriorDespues: fingerprint.deudaAnterior,
        deudaRestanteAntes: fingerprint.deudaRestante,
        deudaRestanteDespues: fingerprint.deudaRestante,
        monedas: []
      });
    }
    const item = byOwner.get(group.ownerId);
    item.pagosAEliminar += group.paymentIds.length;
    item.registrosConsolidados += 1;
    item.montoIdentificado = money(item.montoIdentificado + group.rollupAmount);
    item.monedas.push({ forma: group.mode, pagos: group.paymentIds.length, monto: group.rollupAmount });
  }
  return [...byOwner.values()].sort((a, b) => Number(a.casa || 0) - Number(b.casa || 0));
}

async function loadContext({ token, baseId, counter, month, retentionDays, cutoff }) {
  const ownerQuery = withFields('', OWNER_FIELDS);
  const paymentQuery = withFields('', PAYMENT_FIELDS);
  const receiptQuery = withFields('', RECEIPT_FIELDS);
  const snapshotQuery = `?filterByFormula=${encodeURIComponent(`IFERROR(FIND('AUDITORIA|${month}|', {Concepto}), 0)`)}`;
  const controlQuery = `?filterByFormula=${encodeURIComponent(`LEFT({Key}, 7)='FIN_OP|'`)}`;

  const [owners, payments, receipts, snapshots, controls] = await Promise.all([
    getAll(TABLES.propietarios, ownerQuery, token, baseId, counter),
    getAll(TABLES.pagos, paymentQuery, token, baseId, counter),
    getAll(TABLES.recibos, receiptQuery, token, baseId, counter),
    getAll(TABLES.historial, snapshotQuery, token, baseId, counter),
    getAll(TABLES.control, controlQuery, token, baseId, counter)
  ]);

  const plan = buildPlan({
    owners,
    payments,
    receipts,
    blockedPaymentIds: blockedPaymentIds(controls),
    cutoff,
    month,
    retentionDays,
    snapshotCount: snapshots.length
  });

  return { owners, payments, receipts, snapshots, controls, plan };
}

function archiveRecordFields({ operation, month, cutoff, retentionDays, chunk, chunkIndex, totalChunks, planHash }) {
  const payload = {
    version: 2,
    kind: 'payments-archive-chunk',
    operationId: operation,
    month,
    cutoff,
    retentionDays,
    planHash,
    chunkIndex,
    totalChunks,
    createdAt: new Date().toISOString(),
    payments: chunk
  };
  payload.chunkHash = hashJson(payload.payments);
  return {
    fields: {
      Cierre: `ARCHIVO-${operation}-P${String(chunkIndex).padStart(3, '0')}`,
      'Fecha Cierre': new Date().toISOString(),
      'Fecha Corte': cutoff,
      'Retención Días': retentionDays,
      'Pagos Eliminados': 0,
      'Monto Eliminado USD': money(chunk.reduce((sum, payment) => sum + Number(payment.montoPagado || 0), 0)),
      'Resumen JSON': JSON.stringify(payload),
      'Ejecutado Por': 'Portal Admin',
      Estado: 'Ejecutado'
    }
  };
}

async function createAndVerifyArchive({ plan, operation, token, baseId, counter }) {
  const paymentChunks = chunks(plan.compactPayments, ARCHIVE_CHUNK_SIZE);
  const records = paymentChunks.map((chunk, index) => archiveRecordFields({
    operation,
    month: plan.month,
    cutoff: plan.cutoff,
    retentionDays: plan.retentionDays,
    chunk,
    chunkIndex: index + 1,
    totalChunks: paymentChunks.length,
    planHash: plan.planHash
  }));
  const created = await createRecords(TABLES.cierres, records, token, baseId, counter);
  const prefix = `ARCHIVO-${operation}-P`;
  const query = `?filterByFormula=${encodeURIComponent(`LEFT({Cierre}, ${prefix.length})='${prefix}'`)}`;
  const readBack = await getAll(TABLES.cierres, query, token, baseId, counter);
  if (readBack.length !== records.length) throw new Error(`Archivo incompleto: se esperaban ${records.length} partes y se encontraron ${readBack.length}.`);

  const archivedPayments = [];
  for (const record of readBack) {
    let payload;
    try { payload = JSON.parse(record.fields?.['Resumen JSON'] || '{}'); }
    catch (_) { throw new Error(`Archivo ilegible en ${record.id}.`); }
    if (payload.operationId !== operation || payload.planHash !== plan.planHash) throw new Error(`Archivo no coincide con la operación en ${record.id}.`);
    if (payload.chunkHash !== hashJson(payload.payments || [])) throw new Error(`Hash inválido en archivo ${record.id}.`);
    archivedPayments.push(...(payload.payments || []));
  }
  const archivedIds = archivedPayments.map(payment => payment.id).sort();
  const plannedIds = [...plan.paymentIds].sort();
  if (hashJson(archivedIds) !== hashJson(plannedIds)) throw new Error('El archivo verificado no contiene exactamente todos los pagos planificados.');
  return { created, readBack, archivedPayments };
}

async function pollOwner(ownerId, expectedFingerprint, token, baseId, counter) {
  let last = null;
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
    if (attempt) await wait(VERIFY_WAIT_MS);
    const owner = await getRecord(TABLES.propietarios, ownerId, token, baseId, counter);
    last = ownerFingerprint(owner);
    const comparison = compareFingerprints(expectedFingerprint, last);
    if (comparison.ok) return { ok: true, fingerprint: last, attempts: attempt + 1, differences: [] };
  }
  return { ok: false, fingerprint: last, attempts: VERIFY_ATTEMPTS, differences: compareFingerprints(expectedFingerprint, last).differences };
}

async function relinkReceipts(recreatedMap, compactPayments, token, baseId, counter) {
  const updates = [];
  for (const payment of compactPayments) {
    const newPaymentId = recreatedMap.get(payment.id);
    if (!newPaymentId) continue;
    for (const receipt of payment.recibos || []) updates.push({ id: receipt.id, fields: { Pago: [newPaymentId] } });
  }
  return patchRecords(TABLES.recibos, updates, token, baseId, counter);
}

async function rollbackGroup({ group, aggregateId, deletedIds, beforeFingerprint, token, baseId, counter }) {
  const steps = [];
  let ok = true;
  try {
    if (aggregateId) {
      await deleteRecords(TABLES.pagos, [aggregateId], token, baseId, counter);
      steps.push('consolidado eliminado');
    }
  } catch (error) {
    ok = false;
    steps.push(`no se pudo eliminar consolidado: ${error.message}`);
  }

  const deletedSet = new Set(deletedIds || []);
  const originalsToRestore = group.payments.filter(payment => deletedSet.has(payment.id));
  const recreatedMap = new Map();
  if (originalsToRestore.length) {
    try {
      const recreated = await createRecords(TABLES.pagos, originalsToRestore.map(payment => ({ fields: originalWritableFields(payment) })), token, baseId, counter);
      originalsToRestore.forEach((payment, index) => {
        if (recreated[index]?.id) recreatedMap.set(payment.id, recreated[index].id);
      });
      steps.push(`${recreated.length} pago(s) recreado(s)`);
      await relinkReceipts(recreatedMap, group.compactPayments, token, baseId, counter);
      steps.push('recibos religados');
    } catch (error) {
      ok = false;
      steps.push(`falló restauración: ${error.message}`);
    }
  }

  const verification = await pollOwner(group.ownerId, beforeFingerprint, token, baseId, counter).catch(error => ({ ok: false, differences: [{ field: 'verificación', after: error.message }] }));
  if (!verification.ok) ok = false;
  return { ok, steps, verification, recreated: Object.fromEntries(recreatedMap) };
}

async function processGroup({ group, operation, token, baseId, counter }) {
  const ownerBefore = await getRecord(TABLES.propietarios, group.ownerId, token, baseId, counter);
  const beforeFingerprint = ownerFingerprint(ownerBefore);
  let aggregate = null;
  let deletedIds = [];

  try {
    const created = await createRecords(TABLES.pagos, [{ fields: aggregateFields(group, operation) }], token, baseId, counter);
    aggregate = created[0] || null;
    if (!aggregate?.id) throw new Error('No se pudo crear el registro consolidado.');

    try {
      deletedIds = await deleteRecords(TABLES.pagos, group.paymentIds, token, baseId, counter);
    } catch (error) {
      deletedIds = error.deletedIds || [];
      throw error;
    }
    if (deletedIds.length !== group.paymentIds.length) throw new Error(`Se eliminaron ${deletedIds.length} de ${group.paymentIds.length} pagos del grupo.`);

    const verification = await pollOwner(group.ownerId, beforeFingerprint, token, baseId, counter);
    if (!verification.ok) {
      const mismatch = new Error('Los saldos no coincidieron después de consolidar y eliminar el grupo.');
      mismatch.verification = verification;
      throw mismatch;
    }

    return {
      success: true,
      ownerId: group.ownerId,
      casa: group.casa,
      forma: group.mode,
      pagosEliminados: deletedIds.length,
      montoConsolidado: group.rollupAmount,
      aggregateId: aggregate.id,
      verification
    };
  } catch (error) {
    const rollback = await rollbackGroup({
      group,
      aggregateId: aggregate?.id || null,
      deletedIds,
      beforeFingerprint,
      token,
      baseId,
      counter
    });
    error.rollback = rollback;
    error.aggregateId = aggregate?.id || null;
    error.deletedIds = deletedIds;
    throw error;
  }
}

async function createFinalLog({ operation, plan, groupResults, status, detail, token, baseId, counter }) {
  const payload = {
    version: 2,
    kind: 'audit-cleanup-summary',
    operationId: operation,
    status,
    planHash: plan.planHash,
    month: plan.month,
    cutoff: plan.cutoff,
    retentionDays: plan.retentionDays,
    eligibleCount: plan.eligibleCount,
    totalAmount: plan.totalAmount,
    groups: groupResults,
    detail: detail || null,
    completedAt: new Date().toISOString()
  };
  const deletedCount = groupResults.reduce((sum, item) => sum + Number(item.pagosEliminados || 0), 0);
  const fields = {
    Cierre: `${status === 'Completado' ? 'CIERRE' : 'ERROR'}-${operation}`,
    'Fecha Cierre': new Date().toISOString(),
    'Fecha Corte': plan.cutoff,
    'Retención Días': plan.retentionDays,
    'Pagos Eliminados': deletedCount,
    'Monto Eliminado USD': money(groupResults.reduce((sum, item) => sum + Number(item.montoConsolidado || 0), 0)),
    'Resumen JSON': JSON.stringify(payload),
    'Ejecutado Por': 'Portal Admin',
    Estado: status === 'Completado' ? 'Ejecutado' : 'Error'
  };
  const records = await createRecords(TABLES.cierres, [{ fields }], token, baseId, counter);
  return records[0] || null;
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { message: 'Method Not Allowed' });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' }, counter);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const params = event.queryStringParameters || {};
  const execute = event.httpMethod === 'POST' && (body.execute === true || params.execute === '1');
  const retentionDays = parseRetentionDays(body.retentionDays || params.retentionDays || params.days);
  const cutoff = String(body.cutoff || params.cutoff || cutoffISO(retentionDays)).slice(0, 10);
  const month = normalizeMonth(body.month || params.month);

  try {
    let context = await loadContext({
      token: AIRTABLE_API_TOKEN,
      baseId: AIRTABLE_BASE_ID,
      counter,
      month,
      retentionDays,
      cutoff
    });
    let { owners, plan } = context;
    const summary = summarizePlan(plan, owners);

    if (!execute) {
      return json(200, deepEscapeStrings({
        success: true,
        mode: 'Simulación segura',
        requiredConfirm: CONFIRM_TEXT,
        message: !plan.snapshotComplete
          ? `No se puede ejecutar: el corte ${month} está incompleto (${plan.snapshotCount}/${plan.expectedSnapshotCount} filas).`
          : plan.eligibleCount === 0
            ? 'No existen pagos antiguos cerrados que requieran limpieza.'
            : `Simulación lista. Se archivarán ${plan.eligibleCount} pagos y se reemplazarán por ${plan.groupCount} registros consolidados. Los saldos deben permanecer idénticos.`,
        ...plan,
        groups: undefined,
        compactPayments: undefined,
        paymentIds: undefined,
        summary,
        executionDisabled: !plan.canExecute
      }), counter);
    }

    if (body.confirm !== CONFIRM_TEXT) {
      return json(400, { success: false, message: `Para ejecutar escriba exactamente: ${CONFIRM_TEXT}`, requiredConfirm: CONFIRM_TEXT }, counter);
    }
    if (!plan.snapshotComplete) {
      return json(409, {
        success: false,
        protected: true,
        message: `El corte de auditoría ${month} está incompleto. Se esperaban al menos ${plan.expectedSnapshotCount} filas y existen ${plan.snapshotCount}. No se borró nada.`
      }, counter);
    }
    if (!plan.eligibleCount) {
      return json(200, { success: true, mode: 'Sin cambios', message: 'No había pagos antiguos elegibles. No se creó ni borró ningún registro.', eligibleCount: 0 }, counter);
    }

    const guardKey = `${month}|${cutoff}|${plan.planHash}`;
    const guard = await begin('AUDIT_CLEANUP', guardKey);
    if (!guard.ok) {
      const messages = {
        running: 'Esta limpieza ya está en proceso. Espere y actualice la pantalla.',
        done: 'Esta misma limpieza ya fue ejecutada. No se repitió.',
        partial: 'Esta limpieza tuvo un resultado parcial y requiere revisión antes de repetirla.'
      };
      return json(guard.reason === 'done' ? 200 : 409, {
        success: guard.reason === 'done',
        protected: true,
        reason: guard.reason,
        operationId: guard.marker?.resultId || null,
        message: messages[guard.reason] || 'La operación está protegida.'
      }, counter);
    }

    const operation = operationId();
    const groupResults = [];
    let archive = null;
    try {
      // Releer después del bloqueo para evitar ejecutar con un plan obsoleto.
      context = await loadContext({
        token: AIRTABLE_API_TOKEN,
        baseId: AIRTABLE_BASE_ID,
        counter,
        month,
        retentionDays,
        cutoff
      });
      owners = context.owners;
      const freshPlan = context.plan;
      if (freshPlan.planHash !== plan.planHash) {
        await setState(guard.marker, 'AUDIT_CLEANUP', guardKey, 'ERROR').catch(() => null);
        return json(409, {
          success: false,
          protected: true,
          message: 'Los pagos cambiaron después de la simulación. No se borró nada. Ejecute Simular nuevamente.'
        }, counter);
      }
      plan = freshPlan;

      archive = await createAndVerifyArchive({
        plan,
        operation,
        token: AIRTABLE_API_TOKEN,
        baseId: AIRTABLE_BASE_ID,
        counter
      });

      for (const group of plan.groups) {
        try {
          const result = await processGroup({
            group,
            operation,
            token: AIRTABLE_API_TOKEN,
            baseId: AIRTABLE_BASE_ID,
            counter
          });
          groupResults.push(result);
        } catch (error) {
          const rollbackOk = error.rollback?.ok === true;
          const failure = {
            success: false,
            ownerId: group.ownerId,
            casa: group.casa,
            forma: group.mode,
            pagosEliminados: error.deletedIds?.length || 0,
            montoConsolidado: 0,
            error: safeDisplayText(error.message, 700),
            rollback: deepEscapeStrings(error.rollback)
          };
          groupResults.push(failure);
          await createFinalLog({
            operation,
            plan,
            groupResults,
            status: 'Error',
            detail: rollbackOk ? 'El grupo fallido fue restaurado. Los grupos anteriores permanecen consolidados y verificados.' : 'La restauración del grupo fallido no pudo verificarse completamente.',
            token: AIRTABLE_API_TOKEN,
            baseId: AIRTABLE_BASE_ID,
            counter
          }).catch(() => null);
          await setState(guard.marker, 'AUDIT_CLEANUP', guardKey, rollbackOk ? 'ERROR' : 'PARTIAL', operation).catch(() => null);
          return json(rollbackOk ? 409 : 500, deepEscapeStrings({
            success: false,
            partial: groupResults.some(item => item.success),
            protected: true,
            operationId: operation,
            archived: true,
            archiveParts: archive.readBack.length,
            processedGroups: groupResults,
            message: rollbackOk
              ? 'La limpieza se detuvo. El grupo que falló fue restaurado; los grupos anteriores quedaron consolidados y verificados. Puede simular nuevamente para continuar con los pagos restantes.'
              : 'La limpieza se detuvo y la restauración no pudo verificarse completamente. No repita la operación hasta revisar el cierre y los pagos.'
          }), counter);
        }
      }

      const finalOwners = await getAll(TABLES.propietarios, withFields('', OWNER_FIELDS), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      const initialById = new Map(owners.map(owner => [owner.id, ownerFingerprint(owner)]));
      const globalDifferences = [];
      for (const owner of finalOwners) {
        const before = initialById.get(owner.id);
        if (!before) continue;
        const comparison = compareFingerprints(before, ownerFingerprint(owner));
        if (!comparison.ok) globalDifferences.push({ ownerId: owner.id, casa: owner.fields?.Casa, differences: comparison.differences });
      }
      if (globalDifferences.length) {
        await createFinalLog({
          operation,
          plan,
          groupResults,
          status: 'Error',
          detail: { globalDifferences },
          token: AIRTABLE_API_TOKEN,
          baseId: AIRTABLE_BASE_ID,
          counter
        }).catch(() => null);
        await setState(guard.marker, 'AUDIT_CLEANUP', guardKey, 'PARTIAL', operation).catch(() => null);
        return json(500, deepEscapeStrings({
          success: false,
          partial: true,
          protected: true,
          operationId: operation,
          message: 'Los grupos individuales pasaron, pero la verificación global encontró diferencias. No repita la operación hasta revisar el registro de auditoría.',
          globalDifferences
        }), counter);
      }

      const finalLog = await createFinalLog({
        operation,
        plan,
        groupResults,
        status: 'Completado',
        detail: null,
        token: AIRTABLE_API_TOKEN,
        baseId: AIRTABLE_BASE_ID,
        counter
      });
      await setState(guard.marker, 'AUDIT_CLEANUP', guardKey, 'DONE', operation);

      return json(200, deepEscapeStrings({
        success: true,
        mode: 'Ejecutado',
        operationId: operation,
        archiveParts: archive.readBack.length,
        archiveVerified: true,
        auditRecordId: finalLog?.id || null,
        paymentsArchived: plan.eligibleCount,
        paymentsDeleted: groupResults.reduce((sum, item) => sum + Number(item.pagosEliminados || 0), 0),
        consolidatedRecords: groupResults.length,
        totalAmount: plan.totalAmount,
        processedGroups: groupResults,
        message: `Limpieza completada. Se archivaron y eliminaron ${plan.eligibleCount} pagos detallados, reemplazados por ${groupResults.length} registros consolidados. Todos los saldos fueron verificados sin diferencias.`
      }), counter);
    } catch (error) {
      await createFinalLog({
        operation,
        plan,
        groupResults,
        status: 'Error',
        detail: safeDisplayText(error.message, 1000),
        token: AIRTABLE_API_TOKEN,
        baseId: AIRTABLE_BASE_ID,
        counter
      }).catch(() => null);
      await setState(guard.marker, 'AUDIT_CLEANUP', guardKey, groupResults.length ? 'PARTIAL' : 'ERROR', operation).catch(() => null);
      return json(500, {
        success: false,
        protected: true,
        partial: groupResults.length > 0,
        operationId: operation,
        archived: !!archive,
        message: groupResults.length
          ? 'La limpieza se interrumpió después de completar algunos grupos. Los saldos de esos grupos fueron verificados; simule nuevamente antes de continuar.'
          : 'La limpieza se detuvo antes de borrar pagos. No se alteraron saldos.',
        detail: safeDisplayText(error.message, 1000)
      }, counter);
    }
  } catch (error) {
    return json(500, {
      success: false,
      protected: true,
      message: 'Error preparando el cierre de auditoría.',
      detail: safeDisplayText(error.message, 1000)
    }, counter);
  }
};