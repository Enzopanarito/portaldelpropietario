// netlify/functions/audit-close.js
// Cierre de auditoría seguro: consolida pagos antiguos en Deuda Anterior y luego permite eliminarlos.
// Modo por defecto: simulación. Para ejecutar exige POST + confirmación explícita.

const { requireAdmin } = require('./_auth');

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  historial: 'Historial de Cargos',
  cierres: 'Cierres de Auditoría'
};

const OWNER_FIELDS = [
  'Propietario', 'Casa', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Restante',
  'Cuota Base Mes', 'Total Gastos Especiales del Mes', 'Recargo Aplicado', 'Total Pagado'
];

const PAYMENT_FIELDS = [
  'ID de Pago', 'Propietario que Paga', 'Monto Pagado', 'Fecha de Pago', 'Forma de Pago',
  'Monto Pagado Bs', 'Tasa BCV Aplicada', 'Equivalente USD Aplicado', '[x] Aplicado al Cierre'
];

const CONFIRM_TEXT = 'BORRAR_PAGOS_CERRADOS';

function json(statusCode, body, calls = 0) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Airtable-Calls': String(calls)
    },
    body: JSON.stringify(body)
  };
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

function withFields(query, fields) {
  const params = [];
  (fields || []).forEach(name => params.push('fields%5B%5D=' + encodeURIComponent(name)));
  if (!params.length) return query || '';
  if (!query) return '?' + params.join('&');
  return query + (query.includes('?') && query.length > 1 ? '&' : '?') + params.join('&');
}

async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';
  do {
    const sep = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, safeQuery + (offset ? sep + 'offset=' + encodeURIComponent(offset) : ''));
    counter.calls += 1;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function airtablePatchRecords(tableName, records, token, baseId, counter) {
  const updated = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    counter.calls += 1;
    const res = await fetch(buildUrl(baseId, tableName), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `Error actualizando ${tableName}`);
    updated.push(...(data.records || []));
  }
  return updated;
}

async function airtableDeleteRecords(tableName, ids, token, baseId, counter) {
  const deleted = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const params = batch.map(id => 'records%5B%5D=' + encodeURIComponent(id)).join('&');
    counter.calls += 1;
    const res = await fetch(buildUrl(baseId, tableName, '?' + params), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || data.message || `Error borrando ${tableName}`);
    deleted.push(...(data.records || []));
  }
  return deleted;
}

async function airtableCreateRecord(tableName, fields, token, baseId, counter) {
  counter.calls += 1;
  const res = await fetch(buildUrl(baseId, tableName), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `Error creando registro en ${tableName}`);
  return data.records?.[0] || null;
}

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function monthCaracas() {
  return todayCaracasISO().slice(0, 7);
}

function cutoffISO(retentionDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - retentionDays);
  return d.toISOString().slice(0, 10);
}

function money(v) {
  return Math.round(Number(v || 0) * 100) / 100;
}

function parseRetentionDays(value) {
  const n = parseInt(value || '180', 10);
  if (!Number.isFinite(n)) return 180;
  return Math.min(Math.max(n, 90), 730);
}

function paymentOwnerId(payment) {
  const linked = payment.fields?.['Propietario que Paga'] || [];
  if (!Array.isArray(linked) || linked.length !== 1) return null;
  return linked[0];
}

function paymentAmount(payment) {
  return money(payment.fields?.['Monto Pagado']);
}

function eligiblePayment(payment, cutoff) {
  const f = payment.fields || {};
  const date = String(f['Fecha de Pago'] || '').slice(0, 10);
  if (!date || date > cutoff) return false;
  if (!paymentOwnerId(payment)) return false;
  if (paymentAmount(payment) <= 0) return false;
  return true;
}

function compactPayment(payment) {
  const f = payment.fields || {};
  return {
    id: payment.id,
    pago: f['ID de Pago'] || '',
    fecha: f['Fecha de Pago'] || '',
    montoUsdRef: money(f['Monto Pagado']),
    forma: f['Forma de Pago'] || '',
    montoBs: money(f['Monto Pagado Bs']),
    tasaBcv: money(f['Tasa BCV Aplicada']),
    equivalenteUsdAplicado: money(f['Equivalente USD Aplicado'])
  };
}

function buildPlan(owners, payments, retentionDays, cutoff, month, hasSnapshot) {
  const ownersById = new Map(owners.map(o => [o.id, o]));
  const eligible = [];
  const skipped = [];

  payments.forEach(payment => {
    const f = payment.fields || {};
    const date = String(f['Fecha de Pago'] || '').slice(0, 10);
    if (!date || date > cutoff) return;
    const ownerId = paymentOwnerId(payment);
    const amount = paymentAmount(payment);
    if (!ownerId || !ownersById.has(ownerId) || amount <= 0) {
      skipped.push({ id: payment.id, fecha: date || null, motivo: !ownerId ? 'sin propietario único' : amount <= 0 ? 'monto inválido' : 'propietario no encontrado' });
      return;
    }
    eligible.push(payment);
  });

  const byOwner = new Map();
  eligible.forEach(payment => {
    const ownerId = paymentOwnerId(payment);
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, { sum: 0, payments: [] });
    const item = byOwner.get(ownerId);
    item.sum = money(item.sum + paymentAmount(payment));
    item.payments.push(payment);
  });

  const ownerUpdates = [];
  const ownerSummary = [];
  byOwner.forEach((item, ownerId) => {
    const owner = ownersById.get(ownerId);
    const f = owner.fields || {};
    const currentDebt = money(f['Deuda Anterior']);
    const newDebt = money(currentDebt - item.sum);
    ownerUpdates.push({
      id: ownerId,
      fields: {
        'Deuda Anterior': newDebt,
        'Deuda Anterior USD': newDebt
      }
    });
    ownerSummary.push({
      ownerId,
      casa: f.Casa,
      propietario: f.Propietario,
      deudaAnteriorAntes: currentDebt,
      pagosAntiguosConsolidados: money(item.sum),
      deudaAnteriorDespues: newDebt,
      pagosAEliminar: item.payments.length,
      pagos: item.payments.map(compactPayment)
    });
  });

  const totalAmount = money(eligible.reduce((sum, p) => sum + paymentAmount(p), 0));
  return {
    generatedAt: new Date().toISOString(),
    fechaCaracas: todayCaracasISO(),
    month,
    hasSnapshot,
    retentionDays,
    cutoff,
    eligibleCount: eligible.length,
    skippedCount: skipped.length,
    ownerCount: ownerSummary.length,
    totalAmount,
    paymentsToDelete: eligible.map(p => p.id),
    ownerUpdates,
    summary: ownerSummary.sort((a, b) => Number(a.casa || 0) - Number(b.casa || 0)),
    skipped
  };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const params = event.queryStringParameters || {};
  const execute = event.httpMethod === 'POST' && (body.execute === true || params.execute === '1');
  const confirm = body.confirm || params.confirm || '';
  const retentionDays = parseRetentionDays(body.retentionDays || params.retentionDays || params.days);
  const cutoff = body.cutoff || params.cutoff || cutoffISO(retentionDays);
  const month = body.month || params.month || monthCaracas();

  try {
    const qOwners = withFields('', OWNER_FIELDS);
    const qPayments = withFields('', PAYMENT_FIELDS);
    const qSnapshot = `?filterByFormula=${encodeURIComponent(`IFERROR(FIND('AUDITORIA|${month}|', {Concepto}), 0)`)}&maxRecords=1`;

    const [owners, payments, snapshotRecords] = await Promise.all([
      airtableGetAll(TABLES.propietarios, qOwners, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.pagos, qPayments, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.historial, qSnapshot, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter)
    ]);

    const hasSnapshot = snapshotRecords.length > 0;
    const plan = buildPlan(owners, payments, retentionDays, cutoff, month, hasSnapshot);

    if (!execute) {
      return json(200, {
        success: true,
        mode: 'Simulación',
        message: hasSnapshot
          ? `Simulación lista. Hay ${plan.eligibleCount} pagos antiguos elegibles para consolidar y borrar.`
          : `Simulación lista, pero primero debe existir un corte de auditoría para ${month}.`,
        requiredConfirm: CONFIRM_TEXT,
        ...plan,
        paymentsToDelete: undefined,
        ownerUpdates: undefined
      }, counter.calls);
    }

    if (confirm !== CONFIRM_TEXT) {
      return json(400, { success: false, message: `Para ejecutar debe confirmar con: ${CONFIRM_TEXT}`, requiredConfirm: CONFIRM_TEXT }, counter.calls);
    }
    if (!hasSnapshot && body.allowWithoutSnapshot !== true) {
      return json(409, {
        success: false,
        message: `No se borró nada. Primero genere el corte de auditoría del mes ${month} para dejar respaldo antes de eliminar pagos.`,
        month,
        requiredStep: 'Generar corte de auditoría mensual'
      }, counter.calls);
    }

    if (plan.eligibleCount === 0) {
      return json(200, { success: true, mode: 'Ejecutado', message: 'No había pagos antiguos elegibles para borrar.', ...plan }, counter.calls);
    }

    await airtablePatchRecords(TABLES.propietarios, plan.ownerUpdates, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const deleted = await airtableDeleteRecords(TABLES.pagos, plan.paymentsToDelete, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    const logSummary = {
      month,
      cutoff,
      retentionDays,
      deletedCount: deleted.length,
      totalAmount: plan.totalAmount,
      owners: plan.summary,
      skipped: plan.skipped
    };

    await airtableCreateRecord(TABLES.cierres, {
      'Cierre': `CIERRE-${todayCaracasISO()}-${Date.now().toString().slice(-6)}`,
      'Fecha Cierre': new Date().toISOString(),
      'Fecha Corte': cutoff,
      'Retención Días': retentionDays,
      'Pagos Eliminados': deleted.length,
      'Monto Eliminado USD': plan.totalAmount,
      'Resumen JSON': JSON.stringify(logSummary),
      'Ejecutado Por': 'Portal Admin',
      'Estado': 'Ejecutado'
    }, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    return json(200, {
      success: true,
      mode: 'Ejecutado',
      message: `Cierre ejecutado. Se consolidaron y eliminaron ${deleted.length} pagos antiguos.`,
      deletedCount: deleted.length,
      ...plan,
      paymentsToDelete: undefined,
      ownerUpdates: undefined
    }, counter.calls);
  } catch (error) {
    try {
      await airtableCreateRecord(TABLES.cierres, {
        'Cierre': `ERROR-${todayCaracasISO()}-${Date.now().toString().slice(-6)}`,
        'Fecha Cierre': new Date().toISOString(),
        'Fecha Corte': cutoff,
        'Retención Días': retentionDays,
        'Pagos Eliminados': 0,
        'Monto Eliminado USD': 0,
        'Resumen JSON': JSON.stringify({ error: error.message, month, cutoff }),
        'Ejecutado Por': 'Portal Admin',
        'Estado': 'Error'
      }, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    } catch (_) {}
    return json(500, { success: false, message: 'Error ejecutando cierre de auditoría.', detail: error.message }, counter.calls);
  }
};