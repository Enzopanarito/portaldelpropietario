// netlify/functions/system-health.js
// Panel de salud protegido para revisar componentes críticos del sistema.

const { requireAdmin } = require('./_auth');

const TABLES = ['Propietarios', 'Gastos del Mes', 'Pagos', 'Reportes de Pago', 'Historial de Cargos', 'ControlVersiones'];

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function countTable(tableName, token, baseId) {
  const response = await fetch(buildUrl(baseId, tableName, '?pageSize=1'), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error en ${tableName}`);
  return true;
}

async function getAllGastos(token, baseId) {
  const response = await fetch(buildUrl(baseId, 'Gastos del Mes'), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || 'Error cargando gastos');
  return data.records || [];
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, ADMIN_PASSWORD } = process.env;
  const checks = [];

  function add(name, ok, detail, severity = ok ? 'ok' : 'error') {
    checks.push({ name, ok, detail, severity });
  }

  try {
    add('Token administrativo', true, 'Sesión administrativa válida.');
    add('ADMIN_PASSWORD', !!ADMIN_PASSWORD, ADMIN_PASSWORD ? 'Configurada.' : 'No configurada.');
    add('AIRTABLE_API_TOKEN', !!AIRTABLE_API_TOKEN, AIRTABLE_API_TOKEN ? 'Configurado.' : 'No configurado.');
    add('AIRTABLE_BASE_ID', !!AIRTABLE_BASE_ID, AIRTABLE_BASE_ID ? AIRTABLE_BASE_ID : 'No configurado.');

    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, checks, generatedAt: new Date().toISOString() }) };
    }

    for (const table of TABLES) {
      try {
        await countTable(table, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
        add(`Tabla ${table}`, true, 'Accesible.');
      } catch (error) {
        add(`Tabla ${table}`, false, error.message);
      }
    }

    try {
      const gastos = await getAllGastos(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
      const legacyCount = gastos.filter(g => String((g.fields || {}).Concepto || '').toLowerCase().includes('(cargo individual)')).length;
      add('Modo contable', true, legacyCount > 0 ? `Transición activa: ${legacyCount} cargo(s) individual(es) legacy.` : 'Modo doble moneda limpio.', legacyCount > 0 ? 'warning' : 'ok');
      const unclassified = gastos.filter(g => !((g.fields || {})['Forma de Pago'])).length;
      add('Gastos con forma de pago', unclassified === 0, unclassified ? `${unclassified} gasto(s) sin Forma de Pago.` : 'Todos clasificados.', unclassified ? 'warning' : 'ok');
    } catch (error) {
      add('Validación de gastos', false, error.message);
    }

    try {
      const bcv = await fetch(`${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}/.netlify/functions/bcv-rate`).then(r => r.json());
      add('Tasa BCV', !!bcv.rate, bcv.rate ? (bcv.rateFormatted || String(bcv.rate)) : 'No disponible.', bcv.rate ? 'ok' : 'warning');
    } catch (error) {
      add('Tasa BCV', false, error.message, 'warning');
    }

    const hasError = checks.some(c => c.severity === 'error');
    const hasWarning = checks.some(c => c.severity === 'warning');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: !hasError, status: hasError ? 'error' : hasWarning ? 'warning' : 'ok', checks, generatedAt: new Date().toISOString() })
    };
  } catch (error) {
    add('Error general', false, error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, status: 'error', checks, generatedAt: new Date().toISOString() }) };
  }
};
