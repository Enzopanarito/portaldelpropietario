// netlify/functions/public-data.js
// Endpoint público optimizado: agrupa datos del portal y usa cache en memoria.
// Reduce el consumo de Airtable porque el frontend deja de consultar 3 tablas por separado.

let publicCache = null;
const PUBLIC_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
};

function nowCaracasLabel() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query = '', token, baseId) {
  let records = [];
  let offset = null;

  do {
    const separator = query ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${query}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `Error cargando ${tableName}`);
    }

    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

function compactOwner(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    Casa: f.Casa,
    Propietario: f.Propietario,
    Alicuota: f.Alicuota,
    'Deuda Anterior': f['Deuda Anterior'],
    'Cuota Base Mes': f['Cuota Base Mes'],
    'Total Gastos Especiales del Mes': f['Total Gastos Especiales del Mes'],
    'Recargo Aplicado': f['Recargo Aplicado'],
    'Total Pagado': f['Total Pagado'],
    'Deuda Restante': f['Deuda Restante'],
  };
}

function compactGasto(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    fields: {
      Concepto: f.Concepto,
      Monto: f.Monto,
      'Tipo de Gasto': f['Tipo de Gasto'],
      Frecuencia: f.Frecuencia,
      Propietarios: f.Propietarios || [],
    }
  };
}

function compactPago(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    fields: {
      'Monto Pagado': f['Monto Pagado'],
      'Fecha de Pago': f['Fecha de Pago'],
      'Propietario que Paga': f['Propietario que Paga'] || [],
    }
  };
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  const force = event.queryStringParameters?.force === '1';

  if (!force && publicCache && publicCache.expiresAt > Date.now()) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify(publicCache.payload)
    };
  }

  try {
    const [propietarios, gastos, pagos] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.gastos, '?view=Gastos%20Mensuales', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
      airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID),
    ]);

    const payload = {
      generatedAt: new Date().toISOString(),
      generatedAtCaracas: nowCaracasLabel(),
      propietarios: propietarios.map(compactOwner).sort((a, b) => (a.Casa || 0) - (b.Casa || 0)),
      gastos: gastos.map(compactGasto),
      pagos: pagos.map(compactPago),
    };

    publicCache = {
      payload,
      expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'MISS',
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify(payload)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error cargando datos públicos.', detail: error.message })
    };
  }
};
