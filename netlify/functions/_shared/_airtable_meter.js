'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// El nombre del módulo se conserva temporalmente para no modificar en bloque
// los handlers financieros que ya lo importan. La medición de API fue retirada:
// este wrapper no intercepta fetch, no cuenta llamadas y no escribe en Airtable.
const PUBLIC_SNAPSHOT_MUTATION_SOURCES = new Set([
  'admin-manual-payment',
  'process-payment-report',
  'admin-expense',
  'admin-expense-action',
  'batch-delete-records',
  'monthly-close-v2',
  'monthly-close-v4',
  'automation-settings',
  'access-auto-sync',
  'access-reconciliation-background',
  'mkj-access'
]);
const storage = new AsyncLocalStorage();

function safeSource(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function parseResponseBody(response) {
  try {
    return JSON.parse(response && response.body || '{}');
  } catch (_) {
    return {};
  }
}

function shouldInvalidatePublicSnapshot(source, event, response) {
  if (!PUBLIC_SNAPSHOT_MUTATION_SOURCES.has(source)) return false;
  if (String(event && event.httpMethod || 'GET').toUpperCase() === 'GET') return false;
  const status = Number(response && response.statusCode || 0);
  if (status < 200 || status >= 300) return false;
  const body = parseResponseBody(response);
  if ((source === 'monthly-close-v2' || source === 'monthly-close-v4') && body.dryRun === true) return false;
  if (source === 'mkj-access' && body.action === 'test-login') return false;
  return body.success !== false;
}

async function invalidatePublicSnapshotAfterMutation(source, event, response, state) {
  if (!shouldInvalidatePublicSnapshot(source, event, response)) return;
  try {
    const snapshotStore = require('./_public_snapshot_store');
    const snapshotEnv = snapshotStore.environmentForEvent(event);
    const result = await snapshotStore.invalidatePublicSnapshot(`mutation-${source}`, snapshotEnv);
    state.snapshotInvalidation = result && result.skipped ? 'disabled' : 'invalidated';
  } catch (error) {
    state.snapshotInvalidation = 'failed';
    state.snapshotInvalidationError = String(error.message || error).slice(0, 300);
    console.warn(`No se pudo invalidar la fotografía pública después de ${source}: ${state.snapshotInvalidationError}`);
  }
}

function attachSnapshotHeaders(response, state) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  response.headers = {
    ...(response.headers || {}),
    ...(state.snapshotInvalidation ? { 'X-Public-Snapshot-Invalidation': state.snapshotInvalidation } : {}),
    ...(state.snapshotInvalidationError ? { 'X-Public-Snapshot-Warning': state.snapshotInvalidationError } : {})
  };
  return response;
}

function withAirtableUsage(source, handler) {
  if (typeof handler !== 'function') throw new TypeError('handler debe ser una función.');
  const normalizedSource = safeSource(source);
  return async function runtimeGuard(event, context) {
    if (storage.getStore()) return handler(event, context);
    const state = { source: normalizedSource };
    return storage.run(state, async () => {
      let response;
      let thrown;
      try {
        response = await handler(event, context);
      } catch (error) {
        thrown = error;
      }
      if (!thrown) await invalidatePublicSnapshotAfterMutation(normalizedSource, event, response, state);
      if (thrown) throw thrown;
      return attachSnapshotHeaders(response, state);
    });
  };
}

module.exports = {
  withAirtableUsage,
  _test: {
    safeSource,
    parseResponseBody,
    shouldInvalidatePublicSnapshot,
    invalidatePublicSnapshotAfterMutation,
    PUBLIC_SNAPSHOT_MUTATION_SOURCES
  }
};
