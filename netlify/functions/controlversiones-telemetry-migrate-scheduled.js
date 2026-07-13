'use strict';

const crypto = require('crypto');
const { withAirtableUsage } = require('./_airtable_meter');

const CONTROL_TABLE = 'ControlVersiones';
const MIGRATION_ID = 'CONTROLVERSIONES_TELEMETRY_V1';
const BACKUP_PREFIX = `FULL_BACKUP|${MIGRATION_ID}|DONE|`;
const DONE_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|DONE|`;
const LOCK_PREFIX = `TELEMETRY_MIGRATION|${MIGRATION_ID}|LOCK|`;
const LOCK_TTL_MS = 20 * 60 * 1000;

function endpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}${query}`;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function request(query = '', options = {}) {
  const response = await fetch(endpoint(query), {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
  return data;
}

async function findByPrefix(prefix, maxRecords = 100) {
  const formula = encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
  const data = await request(`?filterByFormula=${formula}&maxRecords=${maxRecords}`);
  return data.records || [];
}

async function createRecord(fields) {
  const data = await request('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return (data.records || [])[0] || null;
}

function secret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || '';
}

function signature() {
  return crypto.createHmac('sha256', secret()).update(MIGRATION_ID).digest('hex');
}

function activeLock(records, now = Date.now()) {
  return (records || []).find(record => {
    const key = String(record?.fields?.Key || '');
    const stamp = (key.match(/\|at=([^|]+)/) || [])[1] || record.createdTime || '';
    const time = Date.parse(stamp);
    return !Number.isFinite(time) || now - time < LOCK_TTL_MS;
  }) || null;
}

async function triggerBackground() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID || !secret()) {
    throw new Error('Faltan variables privadas para ejecutar la migración protegida.');
  }
  const done = await findByPrefix(DONE_PREFIX, 1);
  if (done.length) return { success: true, skipped: true, reason: 'done', markerId: done[0].id };
  const backup = await findByPrefix(BACKUP_PREFIX, 1);
  if (!backup.length) return { success: false, blocked: true, reason: 'backup-missing' };
  const locks = await findByPrefix(LOCK_PREFIX, 100);
  const lock = activeLock(locks);
  if (lock) return { success: true, skipped: true, reason: 'background-running', lockId: lock.id };

  const now = new Date().toISOString();
  const created = await createRecord({
    Key: `${LOCK_PREFIX}at=${now}|nonce=${crypto.randomBytes(6).toString('hex')}`,
    Version: 1
  });
  const origin = String(process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://villalosapamates.netlify.app').replace(/\/$/, '');
  const response = await fetch(`${origin}/.netlify/functions/controlversiones-migrate-background`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VLA-Migration-Signature': signature()
    },
    body: JSON.stringify({ migrationId: MIGRATION_ID, lockId: created?.id || null })
  });
  if (response.status !== 202) {
    const text = await response.text().catch(() => '');
    throw new Error(`No se pudo iniciar la función de segundo plano: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return { success: true, invoked: true, lockId: created?.id || null, status: response.status };
}

const handler = async function () {
  try {
    const result = await triggerBackground();
    return { statusCode: result.success === false ? 409 : 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('CONTROLVERSIONES_TRIGGER_ERROR', String(error.message || '').slice(0, 500));
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ success: false, message: 'No se pudo iniciar la migración protegida.', detail: String(error.message || '').slice(0, 500) }) };
  }
};

exports.handler = withAirtableUsage('controlversiones-telemetry-trigger', handler);
exports.triggerBackground = triggerBackground;
exports.activeLock = activeLock;
exports.signature = signature;
exports.constants = { BACKUP_PREFIX, DONE_PREFIX, LOCK_PREFIX, LOCK_TTL_MS };
