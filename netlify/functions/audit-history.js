// netlify/functions/audit-history.js
// Consulta historial auditable de los últimos meses usando la tabla existente "Historial de Cargos".

const TABLES = {
  propietarios: 'Propietarios',
  historial: 'Historial de Cargos',
  pagos: 'Pagos'
};

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

function monthKeyFromDate(dateString) {
  if (!dateString) return '';
  return String(dateString).slice(0, 7);
}

function monthKeysBack(count) {
  const keys = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function parseAuditConcept(concept) {
  const parts = String(concept || '').split('|');
  if (parts.length < 4 || parts[0] !== 'AUDITORIA') return null;
  const labelRaw = parts.slice(3).join('|');
  const label = labelRaw.split('|')[0].trim();
  return {
    month: parts[1],
    casa: parts[2],
    label: labelRaw
  };
}

function normalizeAuditAmount(value) {
  const n = Number(value || 0);
  return Math.round(n * 100) / 100;
}

function statusFromBalance(balance) {
  if (balance > 0.01) return 'Deuda';
  if (balance < -0.01) return 'Saldo a favor';
  return 'Solvente';
}

function emptyMonthSummary(month) {
  return {
    month,
    hasSnapshot: false,
    saldoInicial: null,
    cargosComunes: null,
    gastosEspeciales: null,
    recargo: null,
    pagosConfirmados: null,
    saldoFinal: null,
    estado: 'Sin corte registrado',
    movements: []
  };
}

function summarizeMonth(month, movements) {
  const summary = emptyMonthSummary(month);
  summary.hasSnapshot = movements.length > 0;
  summary.movements = movements;

  movements.forEach(m => {
    const label = String(m.label || '').toLowerCase();
    const amount = normalizeAuditAmount(m.amount);
    if (label.includes('saldo inicial')) summary.saldoInicial = amount;
    else if (label.includes('cargos comunes')) summary.cargosComunes = amount;
    else if (label.includes('gastos especiales')) summary.gastosEspeciales = amount;
    else if (label.includes('recargo')) summary.recargo = amount;
    else if (label.includes('pagos confirmados')) summary.pagosConfirmados = amount;
    else if (label.includes('saldo final')) {
      summary.saldoFinal = amount;
      summary.estado = statusFromBalance(amount);
    }
  });

  return summary;
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  try {
    const params = event.queryStringParameters || {};
    const ownerId = params.ownerId;
    const monthsCount = Math.min(Math.max(parseInt(params.months || '6', 10) || 6, 1), 12);

    if (!ownerId) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Debe indicar ownerId.' }) };
    }

    const [owners, auditRecords, pagos] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.historial, `?filterByFormula=${encodeURIComponent(`FIND('AUDITORIA|', {Concepto})`)}`, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID)
    ]);

    const owner = owners.find(r => r.id === ownerId);
    if (!owner) {
      return { statusCode: 404, body: JSON.stringify({ message: 'Propietario no encontrado.' }) };
    }

    const months = monthKeysBack(monthsCount);
    const grouped = Object.fromEntries(months.map(m => [m, []]));

    auditRecords.forEach(record => {
      const fields = record.fields || {};
      const linkedOwners = fields.Propietario || [];
      if (!linkedOwners.includes(ownerId)) return;
      const parsed = parseAuditConcept(fields.Concepto);
      if (!parsed || !grouped[parsed.month]) return;
      grouped[parsed.month].push({
        id: record.id,
        month: parsed.month,
        label: parsed.label,
        concept: fields.Concepto,
        amount: normalizeAuditAmount(fields['Monto Cargado']),
        date: fields.Fecha || null
      });
    });

    const summaries = months.map(month => summarizeMonth(month, grouped[month].sort((a, b) => String(a.concept).localeCompare(String(b.concept)))));

    const ownerPayments = pagos
      .filter(p => (p.fields?.['Propietario que Paga'] || []).includes(ownerId))
      .map(p => ({
        id: p.id,
        month: monthKeyFromDate(p.fields?.['Fecha de Pago']),
        date: p.fields?.['Fecha de Pago'],
        amount: normalizeAuditAmount(p.fields?.['Monto Pagado']),
        method: p.fields?.['Método de Pago'] || '',
        reference: p.fields?.['ID de Pago'] || ''
      }))
      .filter(p => months.includes(p.month));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      },
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        owner: { id: owner.id, ...(owner.fields || {}) },
        months: summaries,
        payments: ownerPayments
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ message: 'Error consultando historial de auditoría.', detail: error.message })
    };
  }
};
