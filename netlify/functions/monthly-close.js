// netlify/functions/monthly-close.js
// Cierre mensual seguro.
// 1) Copia la Deuda Restante actual de cada propietario hacia Deuda Anterior.
// 2) Después marca los pagos no cerrados como [x] Aplicado al Cierre.
// Importante: los pagos se marcan DESPUÉS de copiar saldos para no alterar el cálculo antes del cierre.

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  usage: 'ControlVersiones'
};

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function recordApiUsage(source, calls, token, baseId) {
  if (!calls || calls < 1) return;
  const key = `API_USAGE|${currentMonthCaracas()}|${source}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fetch(buildUrl(baseId, TABLES.usage), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields: { Key: key, Version: calls + 1 } }], typecast: true })
    });
  } catch (error) {
    console.warn('No se pudo registrar contador API.', error.message);
  }
}

async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';

  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    counter.calls += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

async function airtablePatchRecords(tableName, records, token, baseId, counter) {
  const updated = [];
  if (!records.length) return updated;

  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    counter.calls += 1;
    const response = await fetch(buildUrl(baseId, tableName), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error actualizando ${tableName}`);
    updated.push(...(data.records || []));
  }

  return updated;
}

function money(value) {
  const n = Number(value || 0);
  return Math.round(n * 100) / 100;
}

function isAppliedPayment(record) {
  return record && record.fields && record.fields['[x] Aplicado al Cierre'] === true;
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const confirmed = body.confirmed === true;

    if (!confirmed) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ message: 'Debe confirmar explícitamente el cierre de mes.' })
      };
    }

    const propietarios = await airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    if (!propietarios.length) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ message: 'No se encontraron propietarios para cerrar el mes.' })
      };
    }

    // Paso 1: congelar el saldo final actual como deuda anterior.
    const ownerUpdates = propietarios.map(owner => ({
      id: owner.id,
      fields: { 'Deuda Anterior': money(owner.fields?.['Deuda Restante']) }
    }));

    const updatedOwners = await airtablePatchRecords(TABLES.propietarios, ownerUpdates, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    // Paso 2: marcar pagos todavía no cerrados para que no sigan afectando el nuevo mes.
    const pagos = await airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const pendingPaymentsToClose = pagos
      .filter(record => !isAppliedPayment(record))
      .map(record => ({ id: record.id, fields: { '[x] Aplicado al Cierre': true } }));

    const updatedPayments = await airtablePatchRecords(TABLES.pagos, pendingPaymentsToClose, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    await recordApiUsage('monthly-close', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    const totalArrastrado = ownerUpdates.reduce((sum, r) => sum + money(r.fields['Deuda Anterior']), 0);
    const conDeuda = ownerUpdates.filter(r => money(r.fields['Deuda Anterior']) > 0.01).length;
    const conSaldoFavor = ownerUpdates.filter(r => money(r.fields['Deuda Anterior']) < -0.01).length;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Airtable-Calls': String(counter.calls + 1)
      },
      body: JSON.stringify({
        success: true,
        month: currentMonthCaracas(),
        updatedCount: updatedOwners.length,
        paymentsClosedCount: updatedPayments.length,
        totalArrastrado: money(totalArrastrado),
        conDeuda,
        conSaldoFavor,
        message: 'Cierre de mes realizado correctamente. Se guardó Deuda Restante como Deuda Anterior y se marcaron los pagos como aplicados al cierre.'
      })
    };
  } catch (error) {
    await recordApiUsage('monthly-close-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls) },
      body: JSON.stringify({ message: 'Error realizando cierre de mes.', detail: error.message })
    };
  }
};
