'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { requireAdmin } = require('./_shared/_auth');
const { begin, setState } = require('./_shared/_operation_guard');
const { safeDisplayText } = require('./_shared/_security_utils');
const { hashJson } = require('./_shared/_audit_cleanup');
const { buildPlan } = require('./_shared/_monthly_close_core_v4');
const { filterClosingExpenses } = require('./_shared/_expense_lifecycle');
const { attachOfficialBalances, officialControlQuery } = require('./_shared/_official_balances');
const { mergeConfig } = require('./_shared/_automation_rules');
const { expectedSnapshotEntries, validateSnapshotRecords } = require('./_shared/_monthly_close_snapshot');
const { isValidMonth, closeWindowForMonth } = require('./_shared/_monthly_close_window');

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  historial: 'Historial de Cargos',
  control: 'ControlVersiones',
  config: 'Configuración'
};
const HF = { propietario:'Propietario', monto:'Monto Cargado', concepto:'Concepto', fecha:'Fecha' };

function json(statusCode, body, counter) {
  return {
    statusCode,
    headers: {
      'Content-Type':'application/json',
      'Cache-Control':'no-store, no-cache, must-revalidate',
      'X-Airtable-Calls':String(counter?.calls || 0)
    },
    body:JSON.stringify(body)
  };
}

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit'
  }).format(new Date());
}

function buildUrl(baseId, tableName, query='') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function request(url, options, counter) {
  counter.calls += 1;
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable HTTP ${response.status}`);
  return data;
}

async function getAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';
  do {
    const separator = safeQuery ? '&' : '?';
    const data = await request(
      buildUrl(baseId, tableName, safeQuery + (offset ? `${separator}offset=${encodeURIComponent(offset)}` : '')),
      { headers:{ Authorization:`Bearer ${token}` } },
      counter
    );
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function createRecords(tableName, records, token, baseId, counter) {
  const created = [];
  for (let index=0; index<records.length; index+=10) {
    const batch = records.slice(index,index+10);
    if (!batch.length) continue;
    const data = await request(buildUrl(baseId,tableName), {
      method:'POST',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ records:batch, typecast:true })
    }, counter);
    created.push(...(data.records || []));
  }
  return created;
}

async function updateRecords(tableName, records, token, baseId, counter) {
  const updated = [];
  for (let index=0; index<records.length; index+=10) {
    const batch = records.slice(index,index+10);
    if (!batch.length) continue;
    const data = await request(buildUrl(baseId,tableName), {
      method:'PATCH',
      headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ records:batch, typecast:true })
    }, counter);
    updated.push(...(data.records || []));
  }
  return updated;
}

function auditQuery(month) {
  return `?filterByFormula=${encodeURIComponent(`FIND('AUDITORIA|${month}|', {Concepto})`)}`;
}

function doneQuery(month) {
  return `?filterByFormula=${encodeURIComponent(`FIND('MONTHLY_CLOSE|${month}|DONE|', {Key})`)}`;
}

function expectedRows(plan, date) {
  return expectedSnapshotEntries(plan).map(entry => ({
    entry,
    fields:{
      [HF.propietario]:[entry.ownerId],
      [HF.fecha]:date,
      [HF.concepto]:entry.concept,
      [HF.monto]:entry.amount
    }
  }));
}

function repairPlan(existing, rows, check) {
  const byConcept = new Map();
  for (const record of existing || []) {
    const key = String(record?.fields?.[HF.concepto] || '');
    if (!byConcept.has(key)) byConcept.set(key,record);
  }
  const mismatch = new Set((check.mismatched || []).map(item => item.concept));
  const creates = [];
  const updates = [];
  for (const row of rows) {
    const current = byConcept.get(row.entry.concept);
    if (!current) creates.push({ fields:row.fields });
    else if (mismatch.has(row.entry.concept)) updates.push({ id:current.id, fields:row.fields });
  }
  return { creates, updates };
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405,{ message:'Method Not Allowed' },{ calls:0 });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls:0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500,{ message:'Airtable no está configurado.' },counter);

  let guard = null;
  let guardKey = '';
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400,{ success:false, message:'Solicitud JSON inválida.' },counter); }

    const month = String(body.month || '').trim();
    if (!isValidMonth(month)) return json(400,{ success:false, protected:true, invalidMonth:true, message:'Debe indicar un mes válido con formato YYYY-MM.' },counter);

    const window = closeWindowForMonth(month);
    if (!window.ok) {
      return json(409,{
        success:false,
        protected:true,
        outsideCloseWindow:true,
        month,
        closeWindow:window,
        message:'El snapshot contable definitivo solo puede generarse o repararse dentro de la ventana real de cierre.'
      },counter);
    }

    const completed = await getAll(TABLES.control, doneQuery(month), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (completed.length) {
      const immutableRows = await getAll(TABLES.historial, auditQuery(month), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      return json(200,{
        success:true,
        skipped:true,
        immutable:true,
        month,
        existingCount:immutableRows.length,
        message:`El cierre ${month} ya fue completado. Su snapshot queda inmutable y no se modifica.`
      },counter);
    }

    const [rawOwners, gastos, pagos, existing, officialRecords, configRecords] = await Promise.all([
      getAll(TABLES.propietarios,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
      getAll(TABLES.gastos,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
      getAll(TABLES.pagos,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
      getAll(TABLES.historial,auditQuery(month),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
      getAll(TABLES.control,officialControlQuery(),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter),
      getAll(TABLES.config,'?maxRecords=1',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter)
    ]);

    const owners = attachOfficialBalances(rawOwners,officialRecords,month);
    const rules = mergeConfig(configRecords[0] || {});
    const closingGastos = filterClosingExpenses(gastos,month);
    const plan = buildPlan({ owners, expenses:closingGastos, payments:pagos, month, dueDay:rules.payment.dueDay, surchargeRate:rules.payment.surchargeRate });
    if (plan.validation?.closeScopeReady === false) {
      return json(409,{
        success:false,
        protected:true,
        month,
        invalidPaymentDatesCount:plan.validation.invalidPaymentDatesCount,
        invalidPaymentIds:plan.validation.invalidPaymentIds,
        message:'Existen pagos sin una fecha válida. El corte se detuvo sin modificar datos.'
      },counter);
    }

    const date = todayCaracasISO();
    const rows = expectedRows(plan,date);
    const initialCheck = validateSnapshotRecords(existing,plan);
    if (initialCheck.complete) {
      return json(200,{
        success:true,
        skipped:true,
        complete:true,
        month,
        owners:owners.length,
        expectedCount:initialCheck.expected,
        existingCount:initialCheck.count,
        createdCount:0,
        updatedCount:0,
        snapshotHash:initialCheck.expectedHash,
        planHash:plan.planHash,
        message:`El corte ${month} coincide exactamente con el plan vigente.`
      },counter);
    }

    if (initialCheck.duplicates.length || initialCheck.unexpected.length) {
      return json(409,{
        success:false,
        protected:true,
        month,
        snapshotConflict:true,
        duplicates:initialCheck.duplicates,
        unexpected:initialCheck.unexpected,
        message:'El snapshot contiene filas duplicadas o inesperadas. Se detuvo sin borrar historial.'
      },counter);
    }

    let changes = repairPlan(existing,rows,initialCheck);
    guardKey = `${month}|${plan.planHash}|${initialCheck.expectedHash}|${hashJson([...changes.creates.map(item=>item.fields[HF.concepto]),...changes.updates.map(item=>item.fields[HF.concepto])].sort())}`;
    const guardResult = await begin('AUDIT_SNAPSHOT',guardKey,{ event });
    if (!guardResult.ok) {
      return json(guardResult.reason === 'done' ? 200 : 409,{
        success:guardResult.reason === 'done',
        protected:true,
        reason:guardResult.reason,
        message:guardResult.reason === 'running'
          ? 'El snapshot ya está siendo generado o reparado.'
          : guardResult.reason === 'done'
            ? 'Este plan de snapshot ya fue procesado.'
            : 'El snapshot requiere revisión antes de continuar.'
      },counter);
    }
    guard = guardResult.marker;

    const reread = await getAll(TABLES.historial,auditQuery(month),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter);
    const rereadCheck = validateSnapshotRecords(reread,plan);
    if (rereadCheck.duplicates.length || rereadCheck.unexpected.length) throw new Error('El snapshot cambió durante la reparación y contiene filas conflictivas.');
    changes = repairPlan(reread,rows,rereadCheck);

    const created = await createRecords(TABLES.historial,changes.creates,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter);
    const updated = await updateRecords(TABLES.historial,changes.updates,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter);

    const finalRows = await getAll(TABLES.historial,auditQuery(month),AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID,counter);
    const finalCheck = validateSnapshotRecords(finalRows,plan);
    if (!finalCheck.complete) throw new Error(`El snapshot quedó fuera del plan: ${finalCheck.count}/${finalCheck.expected}, faltantes=${finalCheck.missing.length}, diferentes=${finalCheck.mismatched.length}.`);

    await setState(guard,'AUDIT_SNAPSHOT',guardKey,'DONE',month);
    return json(200,{
      success:true,
      skipped:false,
      complete:true,
      month,
      owners:owners.length,
      expectedCount:finalCheck.expected,
      existingBefore:existing.length,
      createdCount:created.length,
      updatedCount:updated.length,
      finalCount:finalCheck.count,
      snapshotHash:finalCheck.actualHash,
      planHash:plan.planHash,
      message:`Snapshot ${month} certificado ${finalCheck.count}/${finalCheck.expected} contra el plan vigente.`
    },counter);
  } catch (error) {
    if (guard) await setState(guard,'AUDIT_SNAPSHOT',guardKey,'ERROR').catch(() => null);
    return json(500,{
      success:false,
      protected:true,
      message:'Error generando o reparando el corte de auditoría.',
      detail:safeDisplayText(error.message,1000)
    },counter);
  }
};

exports.handler = withAirtableUsage('audit-snapshot',handler);
