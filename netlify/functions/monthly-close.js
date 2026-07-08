// netlify/functions/monthly-close.js
// Cierre mensual seguro con doble modalidad de pago.
// 1) Calcula saldo final USD y saldo final Bs BCV en referencia USD.
// 2) Guarda esos saldos en Deuda Anterior USD y Deuda Anterior Bs Ref.
// 3) Mantiene Deuda Anterior legacy como total referencial para compatibilidad.
// 4) Después marca los pagos no cerrados como [x] Aplicado al Cierre.

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
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

function ownerShare(gasto, owner) {
  const f = gasto.fields || {};
  const monto = Number(f.Monto || 0);
  const tipo = f['Tipo de Gasto'];
  const linkedOwners = f.Propietarios || [];
  const alicuota = Number((owner.fields || {}).Alicuota || 0);

  if (tipo === 'Gasto Común') return money(monto * alicuota);
  if (tipo === 'Gasto Especial' && linkedOwners.includes(owner.id)) return money(monto / (linkedOwners.length || 1));
  return 0;
}

function paymentEquivalentUsd(payment) {
  const f = payment.fields || {};
  return money(f['Equivalente USD Aplicado'] || f['Monto Pagado'] || 0);
}

function calculateSplitBalance(owner, gastos, pagos) {
  const f = owner.fields || {};
  const splitExists = Math.abs(Number(f['Deuda Anterior USD'] || 0)) > 0.001 || Math.abs(Number(f['Deuda Anterior Bs Ref'] || 0)) > 0.001;
  let usdBalance = Number(f['Deuda Anterior USD'] || 0);
  let bsRefBalance = Number(f['Deuda Anterior Bs Ref'] || 0);

  // Compatibilidad: si todavía no se habían usado saldos separados,
  // la deuda anterior legacy se considera pagadera en Bs BCV.
  if (!splitExists) bsRefBalance += Number(f['Deuda Anterior'] || 0);

  gastos.forEach(gasto => {
    const share = ownerShare(gasto, owner);
    if (share <= 0) return;
    const mode = (gasto.fields || {})['Forma de Pago'] || 'Bs BCV';
    if (mode === 'USD') usdBalance += share;
    else bsRefBalance += share;
  });

  pagos
    .filter(payment => !isAppliedPayment(payment))
    .filter(payment => ((payment.fields || {})['Propietario que Paga'] || []).includes(owner.id))
    .forEach(payment => {
      const mode = (payment.fields || {})['Forma de Pago'] || 'Bs BCV';
      const amount = paymentEquivalentUsd(payment);
      if (mode === 'USD') usdBalance -= amount;
      else bsRefBalance -= amount;
    });

  return {
    usd: money(usdBalance),
    bsRef: money(bsRefBalance),
    totalRef: money(usdBalance + bsRefBalance)
  };
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    if (body.confirmed !== true) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ message: 'Debe confirmar explícitamente el cierre de mes.' }) };
    }

    const [propietarios, gastos, pagos] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.gastos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter)
    ]);

    if (!propietarios.length) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ message: 'No se encontraron propietarios para cerrar el mes.' }) };
    }

    const balancesByOwner = propietarios.map(owner => ({ owner, balance: calculateSplitBalance(owner, gastos, pagos) }));

    const ownerUpdates = balancesByOwner.map(({ owner, balance }) => ({
      id: owner.id,
      fields: {
        'Deuda Anterior USD': balance.usd,
        'Deuda Anterior Bs Ref': balance.bsRef,
        'Deuda Anterior': balance.totalRef
      }
    }));

    const updatedOwners = await airtablePatchRecords(TABLES.propietarios, ownerUpdates, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    const pendingPaymentsToClose = pagos
      .filter(record => !isAppliedPayment(record))
      .map(record => ({ id: record.id, fields: { '[x] Aplicado al Cierre': true } }));

    const updatedPayments = await airtablePatchRecords(TABLES.pagos, pendingPaymentsToClose, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);

    await recordApiUsage('monthly-close-dual-mode', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    const totalUsd = balancesByOwner.reduce((sum, x) => sum + x.balance.usd, 0);
    const totalBsRef = balancesByOwner.reduce((sum, x) => sum + x.balance.bsRef, 0);
    const totalRef = balancesByOwner.reduce((sum, x) => sum + x.balance.totalRef, 0);
    const conDeudaUsd = balancesByOwner.filter(x => x.balance.usd > 0.01).length;
    const conDeudaBs = balancesByOwner.filter(x => x.balance.bsRef > 0.01).length;
    const conSaldoFavor = balancesByOwner.filter(x => x.balance.totalRef < -0.01).length;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls + 1) },
      body: JSON.stringify({
        success: true,
        month: currentMonthCaracas(),
        updatedCount: updatedOwners.length,
        paymentsClosedCount: updatedPayments.length,
        totalUsd: money(totalUsd),
        totalBsRef: money(totalBsRef),
        totalRef: money(totalRef),
        conDeudaUsd,
        conDeudaBs,
        conSaldoFavor,
        message: 'Cierre de mes realizado correctamente con saldos separados USD y Bs BCV.'
      })
    };
  } catch (error) {
    await recordApiUsage('monthly-close-dual-mode-error', counter.calls, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Airtable-Calls': String(counter.calls) }, body: JSON.stringify({ message: 'Error realizando cierre de mes.', detail: error.message }) };
  }
};
