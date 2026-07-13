'use strict';

const { assertSafeAirtableContext, isolationResponse } = require('./_environment_guard');

const TABLE = 'ControlVersiones';
const PREFIX = 'MONTHLY_CLOSE|';
const ACTIVE_TTL_MS = 24 * 60 * 60 * 1000;

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

function parse(record) {
  const key = String(record?.fields?.Key || '');
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.split('|');
  return {
    id: record.id,
    month: parts[1] || '',
    state: parts[2] || '',
    operationId: parts[3] || '',
    createdAt: Date.parse(record.createdTime || '')
  };
}

async function getActiveMonthlyClose() {
  assertSafeAirtableContext({ write: true, allowUnclassified: true });
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) return null;
  const formula = encodeURIComponent(`LEFT({Key}, ${PREFIX.length})='${PREFIX}'`);
  const data = await request(`?filterByFormula=${formula}`);
  const cutoff = Date.now() - ACTIVE_TTL_MS;
  const active = (data.records || [])
    .map(parse)
    .filter(Boolean)
    .filter(item => item.state === 'LOCKED')
    .filter(item => !Number.isFinite(item.createdAt) || item.createdAt >= cutoff)
    .sort((a, b) => {
      const left = Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
      const right = Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
      return left - right || String(a.id).localeCompare(String(b.id));
    });
  return active[0] || null;
}

async function ensureFinancialWritesAllowed() {
  try {
    assertSafeAirtableContext({ write: true, allowUnclassified: true });
  } catch (error) {
    return { ok: false, environmentIsolation: true, response: isolationResponse(error) };
  }
  const active = await getActiveMonthlyClose();
  if (!active) return { ok: true };
  return {
    ok: false,
    active,
    response: {
      statusCode: 423,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '30' },
      body: JSON.stringify({
        success: false,
        protected: true,
        closeInProgress: true,
        month: active.month,
        operationId: active.operationId || null,
        message: `El cierre mensual ${active.month} está en proceso. Los pagos y gastos quedan temporalmente bloqueados para evitar inconsistencias. Intente nuevamente al finalizar.`
      })
    }
  };
}

module.exports = { getActiveMonthlyClose, ensureFinancialWritesAllowed };
