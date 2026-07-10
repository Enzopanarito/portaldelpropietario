// netlify/functions/audit-close.js
// Cierre de auditoría en modo protegido.
// La simulación permanece disponible, pero la ejecución destructiva está bloqueada
// hasta sustituir la lógica antigua por una limpieza idempotente y verificable.

const { requireAdmin } = require('./_auth');

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  historial: 'Historial de Cargos'
};

const OWNER_FIELDS = [
  'Propietario', 'Casa', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Anterior Bs Ref',
  'Deuda Restante', 'Cuota Base Mes', 'Total Gastos Especiales del Mes',
  'Recargo Aplicado', 'Total Pagado'
];

const PAYMENT_FIELDS = [
  'ID de Pago', 'Propietario que Paga', 'Monto Pagado', 'Fecha de Pago', 'Forma de Pago',
  'Monto Pagado Bs', 'Tasa BCV Aplicada', 'Equivalente USD Aplicado', '[x] Aplicado al Cierre'
];

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
  const fields = payment.fields || {};
  return money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0);
}

function compactPayment(payment) {
  const f = payment.fields || {};
  return {
    id: payment.id,
    pago: f['ID de Pago'] || '',
    fecha: f['Fecha de Pago'] || '',
    montoUsdRef: paymentAmount(payment),
    forma: f['Forma de Pago'] || '',
    montoBs: money(f['Monto Pagado Bs']),
    tasaBcv: money(f['Tasa BCV Aplicada']),
    equivalenteUsdAplicado: money(f['Equivalente USD Aplicado']),
    aplicadoAlCierre: f['[x] Aplicado al Cierre'] === true
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
    const alreadyClosed = f['[x] Aplicado al Cierre'] === true;

    let reason = '';
    if (!ownerId) reason = 'sin propietario único';
    else if (!ownersById.has(ownerId)) reason = 'propietario no encontrado';
    else if (!(amount > 0)) reason = 'monto inválido';
    else if (!alreadyClosed) reason = 'pago aún no aplicado a un cierre mensual';

    if (reason) {
      skipped.push({ id: payment.id, fecha: date || null, motivo: reason });
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

  const summary = [];
  byOwner.forEach((item, ownerId) => {
    const owner = ownersById.get(ownerId);
    const f = owner.fields || {};
    const currentDebt = money(f['Deuda Anterior']);
    summary.push({
      ownerId,
      casa: f.Casa,
      propietario: f.Propietario,
      deudaAnteriorAntes: currentDebt,
      deudaAnteriorDespues: currentDebt,
      pagosAntiguosConsolidados: money(item.sum),
      pagosAEliminar: item.payments.length,
      pagos: item.payments.map(compactPayment),
      deudaSeModificaria: false
    });
  });

  const totalAmount = money(eligible.reduce((sum, payment) => sum + paymentAmount(payment), 0));
  return {
    generatedAt: new Date().toISOString(),
    fechaCaracas: todayCaracasISO(),
    month,
    hasSnapshot,
    retentionDays,
    cutoff,
    eligibleCount: eligible.length,
    skippedCount: skipped.length,
    ownerCount: summary.length,
    totalAmount,
    executionDisabled: true,
    protectedMode: true,
    summary: summary.sort((a, b) => Number(a.casa || 0) - Number(b.casa || 0)),
    skipped
  };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return json(500, { message: 'Airtable no está configurado.' }, counter.calls);
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const params = event.queryStringParameters || {};
  const execute = event.httpMethod === 'POST' && (body.execute === true || params.execute === '1');
  const retentionDays = parseRetentionDays(body.retentionDays || params.retentionDays || params.days);
  const cutoff = String(body.cutoff || params.cutoff || cutoffISO(retentionDays)).slice(0, 10);
  const month = normalizeMonth(body.month || params.month);

  if (execute) {
    return json(423, {
      success: false,
      mode: 'Protegido',
      protected: true,
      executionDisabled: true,
      month,
      message: 'La ejecución del Cierre de Auditoría está temporalmente bloqueada para proteger los saldos. La simulación continúa disponible mientras se construye la nueva limpieza segura e idempotente.'
    }, counter.calls);
  }

  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { message: 'Method Not Allowed' }, counter.calls);
  }

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
    return json(200, {
      success: true,
      mode: 'Simulación protegida',
      message: hasSnapshot
        ? `Diagnóstico listo. Se identificaron ${plan.eligibleCount} pagos antiguos ya aplicados a cierres. No se modificó ni borró ningún registro.`
        : `Diagnóstico listo, pero no existe un corte de auditoría para ${month}. No se modificó ni borró ningún registro.`,
      ...plan
    }, counter.calls);
  } catch (error) {
    return json(500, {
      success: false,
      protected: true,
      message: 'Error generando la simulación protegida del cierre de auditoría.',
      detail: error.message
    }, counter.calls);
  }
};