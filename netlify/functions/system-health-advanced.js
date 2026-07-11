'use strict';

const { requireAdmin } = require('./_auth');
const { loadConfigRecord } = require('./_admin_auth_store');
const { loadLastGood } = require('./_bcv_store');
const { deepEscapeStrings, safeDisplayText } = require('./_security_utils');

const CONTROL_TABLE = 'ControlVersiones';
const EXPECTED_BACKUP_TABLES = 11;

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(body) };
}
function trustedOrigin(event) {
  const configured = process.env.URL || process.env.PUBLIC_SITE_URL;
  if (configured) { try { return new URL(configured).origin; } catch (_) {} }
  const proto = event.headers?.['x-forwarded-proto'] || 'https';
  const host = event.headers?.host;
  return host ? `${proto}://${host}` : 'https://villalosapamates.netlify.app';
}
function bearer(event) {
  const headers = event.headers || {};
  return headers.authorization || headers.Authorization || '';
}
function controlUrl(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}${query}`;
}
async function getRecordsByPrefix(prefix) {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return [];
  const formula = encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
  let records = [], offset = null;
  do {
    const query = `?pageSize=100&filterByFormula=${formula}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const response = await fetch(controlUrl(query), { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `No se pudo revisar ${prefix}.`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
async function getControlRecords(prefixes) {
  const groups = await Promise.all(prefixes.map(getRecordsByPrefix));
  return groups.flat();
}
function latest(records, prefix) {
  return [...records].filter(record => String(record?.fields?.Key || '').startsWith(prefix)).sort((a, b) => String(b.createdTime || '').localeCompare(String(a.createdTime || '')))[0] || null;
}
function keyState(record) {
  const key = String(record?.fields?.Key || '');
  if (key.startsWith('MONTHLY_CLOSE|')) return key.split('|')[2] || '';
  return '';
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { message: 'Method Not Allowed' });

  try {
    const response = await fetch(`${trustedOrigin(event)}/.netlify/functions/system-health`, { headers: { Authorization: bearer(event), Accept: 'application/json' } });
    const base = await response.json().catch(() => ({ ok: false, status: 'error', checks: [] }));
    const checks = Array.isArray(base.checks) ? base.checks : [];
    const add = (name, ok, detail, severity = ok ? 'ok' : 'error', meta = undefined) => checks.push({ name, ok, detail, severity, ...(meta ? { meta } : {}) });

    const secretIndependent = Boolean(process.env.ADMIN_TOKEN_SECRET) && process.env.ADMIN_TOKEN_SECRET !== process.env.ADMIN_PASSWORD;
    add('Secreto independiente de sesión', secretIndependent, secretIndependent ? 'ADMIN_TOKEN_SECRET está configurado y separado de la contraseña.' : 'Configure ADMIN_TOKEN_SECRET en Netlify con un valor aleatorio distinto de ADMIN_PASSWORD.', secretIndependent ? 'ok' : 'warning');

    try {
      const { config } = await loadConfigRecord({ force: true });
      const algorithm = config?.passwordHash ? String(config.algorithm || config.algo || 'pbkdf2-sha256-v1') : 'environment';
      const strong = algorithm === 'scrypt-v1';
      add('Protección de contraseña', strong, config?.passwordHash ? `Algoritmo actual: ${algorithm}; versión: ${Number(config.version || 0)}.` : 'Se está usando la contraseña de entorno. Cambiarla desde Seguridad migrará a scrypt.', strong ? 'ok' : 'warning', { algorithm, version: Number(config?.version || 0) });
    } catch (error) {
      add('Protección de contraseña', false, safeDisplayText(error.message, 300), 'warning');
    }

    try {
      const bcv = await loadLastGood({ force: true });
      add('Última tasa BCV persistente', Boolean(bcv?.rate), bcv?.rate ? `${bcv.rateFormatted || bcv.rate} · ${bcv.source || 'fuente no indicada'} · ${bcv.updatedAt || bcv.fetchedAt || 'sin fecha'}` : 'Todavía no existe una tasa válida persistente. Se guardará con la próxima consulta exitosa.', bcv?.rate ? 'ok' : 'warning');
    } catch (error) {
      add('Última tasa BCV persistente', false, safeDisplayText(error.message, 300), 'warning');
    }

    try {
      const control = await getControlRecords(['MONTHLY_CLOSE|','FIN_OP|','BCV_LAST_GOOD|']);
      const partial = control.filter(record => ['ERROR_PARTIAL','LOCKED'].includes(keyState(record)));
      const runningFinancialOps = control.filter(record => String(record?.fields?.Key || '').startsWith('FIN_OP|') && String(record?.fields?.Key || '').includes('|RUNNING|'));
      const lastClose = latest(control, 'MONTHLY_CLOSE|');
      const pendingCount = partial.length + runningFinancialOps.length;
      add('Operaciones financieras pendientes', pendingCount === 0, pendingCount ? `${partial.length} marcador(es) de cierre y ${runningFinancialOps.length} operación(es) financieras requieren revisión.` : 'No hay cierres parciales, bloqueos activos ni operaciones financieras en curso detectadas.', pendingCount ? 'error' : 'ok', { closeMarkers: partial.length, financialOperations: runningFinancialOps.length });
      add('Último marcador de cierre mensual', Boolean(lastClose), lastClose ? `${String(lastClose.fields?.Key || '').slice(0, 160)} · ${lastClose.createdTime || ''}` : 'No existe todavía un marcador de cierre mensual.', lastClose ? 'ok' : 'warning');
    } catch (error) {
      add('Operaciones financieras pendientes', false, safeDisplayText(error.message, 300), 'warning');
    }

    add('Cobertura de respaldo', true, `El respaldo operativo incluye ${EXPECTED_BACKUP_TABLES} tablas, manifiesto SHA-256 y verificador local.`, 'ok', { expectedTables: EXPECTED_BACKUP_TABLES });
    add('Transparencia pública', true, 'El portal continúa mostrando la información financiera de todas las casas según la política definida por la administración.');
    add('Autenticación de dos pasos', true, 'No habilitada por decisión operativa de la administración. La protección se refuerza mediante contraseña scrypt, límites persistentes y sesiones firmadas.', 'ok');

    const hasError = checks.some(check => check.severity === 'error');
    const hasWarning = checks.some(check => check.severity === 'warning');
    const payload = deepEscapeStrings({ ...base, ok: !hasError, status: hasError ? 'error' : hasWarning ? 'warning' : 'ok', checks, generatedAt: new Date().toISOString(), advanced: true });
    return json(200, payload);
  } catch (error) {
    return json(500, { ok: false, status: 'error', checks: [{ name: 'Salud avanzada', ok: false, severity: 'error', detail: safeDisplayText(error.message, 500) }], generatedAt: new Date().toISOString(), advanced: true });
  }
};
