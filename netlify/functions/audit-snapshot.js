// netlify/functions/audit-snapshot.js
// Genera o repara el corte de auditoría mensual con USD y Bs BCV.
// Nunca duplica conceptos existentes y verifica las 10 filas esperadas por propietario.

'use strict';

const { requireAdminCurrent } = require('./_auth');
const { begin, setState } = require('./_operation_guard');
const { safeDisplayText } = require('./_security_utils');
const { hashJson } = require('./_audit_cleanup');

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  historial: 'Historial de Cargos'
};
const HF = { propietario: 'Propietario', monto: 'Monto Cargado', concepto: 'Concepto', fecha: 'Fecha' };
const ROWS_PER_OWNER = 10;

function json(statusCode, body, counter) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Airtable-Calls': String(counter?.calls || 0)
    },
    body: JSON.stringify(body)
  };
}

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function currentMonthCaracas() {
  return todayCaracasISO().slice(0, 7);
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonthCaracas();
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildUrl(baseId, tableName, query = '') {
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
      { headers: { Authorization: `Bearer ${token}` } },
      counter
    );
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
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

function hasLegacyIndividualCharges(gastos) {
  return gastos.some(gasto => String(gasto.fields?.Concepto || '').toLowerCase().includes('(cargo individual)'));
}

function isAppliedPayment(payment) {
  return payment?.fields?.['[x] Aplicado al Cierre'] === true;
}

function ownerShare(gasto, owner) {
  const fields = gasto.fields || {};
  const amount = Number(fields.Monto || 0);
  const type = fields['Tipo de Gasto'];
  const linked = fields.Propietarios || [];
  const share = Number(owner.fields?.Alicuota || 0);
  if (type === 'Gasto Común') return money(amount * share);
  if (type === 'Gasto Especial' && linked.includes(owner.id)) return money(amount / (linked.length || 1));
  return 0;
}

function paymentEquivalentUsd(payment) {
  const fields = payment.fields || {};
  return money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0);
}

function explicitNegativeSplit(total, initialUsd, initialBs, rawUsd, rawBs) {
  if (total >= -0.01) return { usd: 0, bs: 0 };
  if (initialUsd < -0.01 && Math.abs(initialBs) <= 0.01) return { usd: total, bs: 0 };
  if (initialBs < -0.01 && Math.abs(initialUsd) <= 0.01) return { usd: 0, bs: total };
  const negativeUsd = Math.max(0, -rawUsd);
  const negativeBs = Math.max(0, -rawBs);
  const negativeTotal = negativeUsd + negativeBs;
  if (negativeTotal <= 0.01) return { usd: 0, bs: total };
  if (negativeUsd > 0.01 && negativeBs <= 0.01) return { usd: total, bs: 0 };
  if (negativeBs > 0.01 && negativeUsd <= 0.01) return { usd: 0, bs: total };
  const usd = money(total * (negativeUsd / negativeTotal));
  return { usd, bs: money(total - usd) };
}

function compute(owner, gastos, pagos, transitionMode) {
  const fields = owner.fields || {};
  const initialUsd = Number(fields['Deuda Anterior USD'] || 0);
  const initialBsBase = Number(fields['Deuda Anterior Bs Ref'] || 0);
  const splitExists = Math.abs(initialUsd) > 0.001 || Math.abs(initialBsBase) > 0.001;
  let initialBs = initialBsBase;
  if (!splitExists) initialBs += Number(fields['Deuda Anterior'] || 0);

  let chargesUsd = 0;
  let chargesBs = 0;
  let paidUsd = 0;
  let paidBs = 0;
  for (const gasto of gastos) {
    const share = ownerShare(gasto, owner);
    if (share <= 0) continue;
    const mode = gasto.fields?.['Forma de Pago'] || 'Bs BCV';
    if (mode === 'USD') chargesUsd += share;
    else chargesBs += share;
  }
  for (const payment of pagos) {
    if (isAppliedPayment(payment)) continue;
    if (!((payment.fields || {})['Propietario que Paga'] || []).includes(owner.id)) continue;
    const mode = payment.fields?.['Forma de Pago'] || 'Bs BCV';
    const amount = paymentEquivalentUsd(payment);
    if (mode === 'USD') paidUsd += amount;
    else paidBs += amount;
  }

  const rawUsd = money(initialUsd + chargesUsd - paidUsd);
  const rawBs = money(initialBs + chargesBs - paidBs);
  const rawTotal = money(rawUsd + rawBs);
  const legacyTotal = money(fields['Deuda Restante']);
  let finalUsd = rawUsd;
  let finalBs = rawBs;
  let total = rawTotal;

  if (transitionMode) {
    total = legacyTotal;
    if (total <= 0.01) {
      const negative = explicitNegativeSplit(total, initialUsd, initialBsBase, rawUsd, rawBs);
      finalUsd = negative.usd;
      finalBs = negative.bs;
    } else {
      const positiveUsd = Math.max(0, rawUsd);
      const positiveBs = Math.max(0, rawBs);
      const positiveTotal = positiveUsd + positiveBs;
      if (positiveTotal <= 0.01) {
        finalUsd = 0;
        finalBs = total;
      } else {
        finalUsd = money(total * (positiveUsd / positiveTotal));
        finalBs = money(total - finalUsd);
      }
    }
  }

  return {
    initialUsd: money(initialUsd), initialBs: money(initialBs),
    chargesUsd: money(chargesUsd), chargesBs: money(chargesBs),
    paidUsd: money(paidUsd), paidBs: money(paidBs),
    finalUsd: money(finalUsd), finalBs: money(finalBs), total: money(total),
    rawTotal, legacyTotal
  };
}

function status(balance) {
  if (balance > 0.01) return 'Deuda';
  if (balance < -0.01) return 'Saldo a favor';
  return 'Solvente';
}

function concept(month, casa, label) {
  return `AUDITORIA|${month}|Casa ${casa}|${label}`;
}

function rows(owner, calculation, month, date, transitionMode) {
  const casa = owner.fields?.Casa || 'N/A';
  const ownerName = owner.fields?.Propietario || 'Sin nombre';
  const base = { [HF.propietario]: [owner.id], [HF.fecha]: date };
  return [
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Saldo inicial USD | ${ownerName}`), [HF.monto]: calculation.initialUsd } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Saldo inicial Bs Ref | ${ownerName}`), [HF.monto]: calculation.initialBs } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Cargos USD | ${ownerName}`), [HF.monto]: calculation.chargesUsd } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Cargos Bs Ref | ${ownerName}`), [HF.monto]: calculation.chargesBs } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Pagos USD | ${ownerName}`), [HF.monto]: -Math.abs(calculation.paidUsd) } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Pagos Bs Ref | ${ownerName}`), [HF.monto]: -Math.abs(calculation.paidBs) } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Saldo final USD | ${ownerName}`), [HF.monto]: calculation.finalUsd } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Saldo final Bs Ref | ${ownerName}`), [HF.monto]: calculation.finalBs } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Saldo final total (${status(calculation.total)}) | ${ownerName}`), [HF.monto]: calculation.total } },
    { fields: { ...base, [HF.concepto]: concept(month, casa, `Modo de cálculo ${transitionMode ? 'transición legacy' : 'doble moneda'} | ${ownerName}`), [HF.monto]: 0 } }
  ];
}

function auditQuery(month) {
  return `?filterByFormula=${encodeURIComponent(`IFERROR(FIND('AUDITORIA|${month}|', {Concepto}), 0)`)}`;
}

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' }, { calls: 0 });

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' }, counter);

  let guard = null;
  let guardKey = '';
  try {
    const body = JSON.parse(event.body || '{}');
    const month = normalizeMonth(body.month);
    const date = String(body.date || todayCaracasISO()).slice(0, 10);

    const [owners, gastos, pagos, existing] = await Promise.all([
      getAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      getAll(TABLES.gastos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      getAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      getAll(TABLES.historial, auditQuery(month), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter)
    ]);

    const transitionMode = hasLegacyIndividualCharges(gastos);
    const expectedRows = owners.flatMap(owner => rows(owner, compute(owner, gastos, pagos, transitionMode), month, date, transitionMode));
    const existingConcepts = new Set(existing.map(record => String(record.fields?.Concepto || '')));
    let missingRows = expectedRows.filter(row => !existingConcepts.has(String(row.fields?.Concepto || '')));
    const expectedCount = owners.length * ROWS_PER_OWNER;

    if (!missingRows.length) {
      return json(200, {
        success: true,
        skipped: true,
        complete: existing.length >= expectedCount,
        month,
        owners: owners.length,
        expectedCount,
        existingCount: existing.length,
        createdCount: 0,
        transitionMode,
        message: `El corte ${month} ya contiene todas las filas esperadas.`
      }, counter);
    }

    guardKey = `${month}|${hashJson(missingRows.map(row => row.fields[HF.concepto]).sort())}`;
    const guardResult = await begin('AUDIT_SNAPSHOT', guardKey);
    if (!guardResult.ok) {
      return json(guardResult.reason === 'done' ? 200 : 409, {
        success: guardResult.reason === 'done',
        protected: true,
        reason: guardResult.reason,
        message: guardResult.reason === 'running'
          ? 'El corte de auditoría ya está siendo generado. Espere y vuelva a revisar.'
          : guardResult.reason === 'done'
            ? 'Estas filas del corte ya fueron generadas.'
            : 'El corte requiere revisión antes de continuar.'
      }, counter);
    }
    guard = guardResult.marker;

    const reread = await getAll(TABLES.historial, auditQuery(month), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const rereadConcepts = new Set(reread.map(record => String(record.fields?.Concepto || '')));
    missingRows = expectedRows.filter(row => !rereadConcepts.has(String(row.fields?.Concepto || '')));
    const created = await createRecords(TABLES.historial, missingRows, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    const finalRows = await getAll(TABLES.historial, auditQuery(month), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const finalConcepts = new Set(finalRows.map(record => String(record.fields?.Concepto || '')));
    const stillMissing = expectedRows.filter(row => !finalConcepts.has(String(row.fields?.Concepto || '')));
    if (stillMissing.length) throw new Error(`El corte quedó incompleto: faltan ${stillMissing.length} filas esperadas.`);

    await setState(guard, 'AUDIT_SNAPSHOT', guardKey, 'DONE', month);
    return json(200, {
      success: true,
      skipped: false,
      complete: true,
      month,
      owners: owners.length,
      expectedCount,
      existingBefore: existing.length,
      createdCount: created.length,
      finalCount: finalRows.length,
      transitionMode,
      message: created.length
        ? `Corte ${month} completado o reparado correctamente. Se crearon ${created.length} filas faltantes.`
        : `Corte ${month} verificado correctamente.`
    }, counter);
  } catch (error) {
    if (guard) await setState(guard, 'AUDIT_SNAPSHOT', guardKey, 'ERROR').catch(() => null);
    return json(500, {
      success: false,
      protected: true,
      message: 'Error generando o reparando el corte de auditoría.',
      detail: safeDisplayText(error.message, 1000)
    }, counter);
  }
};