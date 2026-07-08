// netlify/functions/audit-snapshot.js
// Genera un corte de auditoría mensual usando la tabla existente "Historial de Cargos".
// No cambia fórmulas ni estructura de Airtable. Solo crea movimientos auditables.

const TABLES = {
  propietarios: 'Propietarios',
  historial: 'Historial de Cargos'
};

const HISTORIAL_FIELDS = {
  propietario: 'Propietario',
  monto: 'Monto Cargado',
  concepto: 'Concepto',
  fecha: 'Fecha'
};

function todayCaracasISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  return `${year}-${month}`;
}

function money(value) {
  const num = Number(value || 0);
  return Math.round(num * 100) / 100;
}

function statusFromBalance(balance) {
  if (balance > 0.01) return 'Deuda';
  if (balance < -0.01) return 'Saldo a favor';
  return 'Solvente';
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query, token, baseId) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';

  do {
    const separator = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    }

    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

async function airtableCreateRecords(tableName, records, token, baseId) {
  const created = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const response = await fetch(buildUrl(baseId, tableName), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: batch, typecast: true })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || data.message || `Error creando registros en ${tableName}`);
    }
    created.push(...(data.records || []));
  }
  return created;
}

function auditConcept(month, casa, label) {
  return `AUDITORIA|${month}|Casa ${casa}|${label}`;
}

function buildOwnerAuditRows(owner, month, date) {
  const casa = owner.fields?.Casa || 'N/A';
  const propietario = owner.fields?.Propietario || 'Sin nombre';
  const saldoInicial = money(owner.fields?.['Deuda Anterior']);
  const cargosComunes = money(owner.fields?.['Cuota Base Mes']);
  const gastosEspeciales = money(owner.fields?.['Total Gastos Especiales del Mes']);
  const recargo = money(owner.fields?.['Recargo Aplicado']);
  const totalPagado = money(owner.fields?.['Total Pagado']);
  const saldoFinal = money(owner.fields?.['Deuda Restante']);
  const estado = statusFromBalance(saldoFinal);

  const baseFields = {
    [HISTORIAL_FIELDS.propietario]: [owner.id],
    [HISTORIAL_FIELDS.fecha]: date
  };

  return [
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Saldo inicial | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: saldoInicial
      }
    },
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Cargos comunes | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: cargosComunes
      }
    },
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Gastos especiales | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: gastosEspeciales
      }
    },
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Recargo | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: recargo
      }
    },
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Pagos confirmados | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: -Math.abs(totalPagado)
      }
    },
    {
      fields: {
        ...baseFields,
        [HISTORIAL_FIELDS.concepto]: auditConcept(month, casa, `Saldo final (${estado}) | ${propietario}`),
        [HISTORIAL_FIELDS.monto]: saldoFinal
      }
    }
  ];
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const month = body.month || currentMonthCaracas();
    const force = body.force === true;
    const date = body.date || todayCaracasISO();

    const existing = await airtableGetAll(
      TABLES.historial,
      `?filterByFormula=${encodeURIComponent(`FIND('AUDITORIA|${month}|', {Concepto})`)}`,
      AIRTABLE_API_TOKEN,
      AIRTABLE_BASE_ID
    );

    if (existing.length > 0 && !force) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          success: true,
          skipped: true,
          message: `Ya existe un corte de auditoría para ${month}.`,
          month,
          existingCount: existing.length
        })
      };
    }

    const propietarios = await airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    const auditRows = propietarios.flatMap(owner => buildOwnerAuditRows(owner, month, date));
    const created = await airtableCreateRecords(TABLES.historial, auditRows, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        success: true,
        skipped: false,
        month,
        owners: propietarios.length,
        createdCount: created.length,
        message: `Corte de auditoría ${month} generado correctamente.`
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'Error generando corte de auditoría.', detail: error.message })
    };
  }
};
