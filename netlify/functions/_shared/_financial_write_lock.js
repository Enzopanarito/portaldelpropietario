'use strict';

const TABLE = 'ControlVersiones';
const PREFIX = 'MONTHLY_CLOSE|';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}

async function request(query = '') {
  const response = await fetch(endpoint(query), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || 'No se pudo consultar el bloqueo financiero.');
  return data;
}

function parse(record, now = Date.now()) {
  const key = String(record?.fields?.Key || '');
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.split('|');
  const createdAt = Date.parse(record.createdTime || '');
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null;
  return {
    id: record.id,
    month: parts[1] || '',
    state: parts[2] || '',
    operationId: parts[3] || '',
    createdAt,
    ageMs,
    stale: ageMs === null || ageMs >= STALE_AFTER_MS
  };
}

async function getActiveMonthlyClose() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return null;
  const formula = encodeURIComponent(`LEFT({Key}, ${PREFIX.length})='${PREFIX}'`);
  const data = await request(`?filterByFormula=${formula}`);
  const now = Date.now();
  const active = (data.records || [])
    .map(record => parse(record, now))
    .filter(Boolean)
    .filter(item => item.state === 'LOCKED')
    // Fail closed: un LOCKED nunca se ignora solo por antigüedad. Un bloqueo
    // viejo pasa a estado operativo "stale" y exige recuperación explícita.
    .sort((a, b) => {
      const left = Number.isFinite(a.createdAt) ? a.createdAt : Number.MIN_SAFE_INTEGER;
      const right = Number.isFinite(b.createdAt) ? b.createdAt : Number.MIN_SAFE_INTEGER;
      return left - right || String(a.id).localeCompare(String(b.id));
    });
  return active[0] || null;
}

async function ensureFinancialWritesAllowed() {
  const active = await getActiveMonthlyClose();
  if (!active) return { ok: true };
  const staleMessage = `El cierre mensual ${active.month} conserva un bloqueo antiguo sin resolución. Por seguridad, pagos y gastos permanecen bloqueados hasta una recuperación administrativa explícita.`;
  const activeMessage = `El cierre mensual ${active.month} está en proceso. Los pagos y gastos quedan temporalmente bloqueados para evitar inconsistencias. Intente nuevamente al finalizar.`;
  return {
    ok: false,
    active,
    response: {
      statusCode: 423,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': active.stale ? '300' : '30' },
      body: JSON.stringify({
        success: false,
        protected: true,
        closeInProgress: true,
        staleLock: active.stale === true,
        requiresRecovery: active.stale === true,
        month: active.month,
        operationId: active.operationId || null,
        ageMs: active.ageMs,
        message: active.stale ? staleMessage : activeMessage
      })
    }
  };
}

module.exports = { STALE_AFTER_MS, parse, getActiveMonthlyClose, ensureFinancialWritesAllowed };
