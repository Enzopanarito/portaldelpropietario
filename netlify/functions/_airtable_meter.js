'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const CONTROL_TABLE = 'ControlVersiones';
const AIRTABLE_PREFIX = 'https://api.airtable.com/v0/';
const DEFAULT_MONTHLY_LIMIT = 1000;
const storage = new AsyncLocalStorage();
const rawFetch = globalThis.__VLA_AIRTABLE_RAW_FETCH || globalThis.fetch.bind(globalThis);

function currentMonthCaracas(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit'
  }).formatToParts(date);
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function safeSource(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  try { return String(input || ''); } catch (_) { return ''; }
}

function requestMethod(input, init) {
  return String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
}

function isAirtableUrl(url) {
  return String(url || '').startsWith(AIRTABLE_PREFIX);
}

if (!globalThis.__VLA_AIRTABLE_METER_INSTALLED) {
  globalThis.__VLA_AIRTABLE_METER_INSTALLED = true;
  globalThis.__VLA_AIRTABLE_RAW_FETCH = rawFetch;
  globalThis.fetch = async function meteredFetch(input, init) {
    const state = storage.getStore();
    const url = requestUrl(input);
    if (state && !state.logging && isAirtableUrl(url)) {
      state.calls += 1;
      const method = requestMethod(input, init);
      state.byMethod[method] = (state.byMethod[method] || 0) + 1;
    }
    return rawFetch(input, init);
  };
}

function usageTableUrl() {
  return `${AIRTABLE_PREFIX}${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(CONTROL_TABLE)}`;
}

function currentUsageSnapshot() {
  const state = storage.getStore();
  if (!state) return { source: null, calls: 0, byMethod: {}, projectedRecordedCalls: 0 };
  return {
    source: state.source,
    calls: state.calls,
    byMethod: { ...state.byMethod },
    projectedRecordedCalls: state.calls > 0 ? state.calls + 1 : 0
  };
}

async function persistUsage(state) {
  if (!state || state.calls < 1 || state.flushed) return state;
  state.flushed = true;
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) {
    state.logStatus = 'not-configured';
    return state;
  }

  state.logging = true;
  const month = currentMonthCaracas();
  const timestamp = new Date().toISOString();
  const key = `API_USAGE|${month}|${state.source}|${timestamp}|${crypto.randomBytes(4).toString('hex')}`;
  let attempts = 0;

  try {
    while (attempts < 2) {
      attempts += 1;
      const recordedCalls = state.calls + attempts;
      try {
        const response = await rawFetch(usageTableUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ records: [{ fields: { Key: key, Version: recordedCalls } }], typecast: true })
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error?.message || data.message || `Airtable respondió ${response.status}.`);
        }
        state.loggingCalls = attempts;
        state.recordedCalls = recordedCalls;
        state.logStatus = 'recorded';
        return state;
      } catch (error) {
        state.logError = String(error.message || error).slice(0, 300);
        if (attempts < 2) await new Promise(resolve => setTimeout(resolve, 120));
      }
    }

    state.loggingCalls = attempts;
    state.recordedCalls = state.calls + attempts;
    state.logStatus = 'failed';
    console.warn(`No se pudo registrar uso Airtable para ${state.source}: ${state.logError || 'error desconocido'}`);
    return state;
  } finally {
    state.logging = false;
  }
}

function attachUsageHeaders(response, state) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const attempted = state.recordedCalls || state.calls || 0;
  response.headers = {
    ...(response.headers || {}),
    'X-Airtable-Calls': String(attempted),
    'X-Airtable-Usage-Source': state.source,
    'X-Airtable-Usage-Logged': state.logStatus || 'not-needed'
  };
  return response;
}

function withAirtableUsage(source, handler) {
  if (typeof handler !== 'function') throw new TypeError('handler debe ser una función.');
  const normalizedSource = safeSource(source);

  return async function meteredHandler(event, context) {
    // Los handlers anidados comparten una sola medición y un solo evento agregado.
    if (storage.getStore()) return handler(event, context);

    const state = {
      source: normalizedSource,
      calls: 0,
      byMethod: {},
      logging: false,
      flushed: false,
      startedAt: Date.now()
    };

    return storage.run(state, async () => {
      let response;
      let thrown;
      try {
        response = await handler(event, context);
      } catch (error) {
        thrown = error;
      }
      await persistUsage(state);
      if (thrown) throw thrown;
      return attachUsageHeaders(response, state);
    });
  };
}

async function flushCurrentUsage() {
  const state = storage.getStore();
  if (!state) return { source: null, calls: 0, byMethod: {}, logStatus: 'no-context', recordedCalls: 0 };
  await persistUsage(state);
  return {
    source: state.source,
    calls: state.calls,
    byMethod: { ...state.byMethod },
    logStatus: state.logStatus || 'not-needed',
    recordedCalls: state.recordedCalls || 0,
    logError: state.logError || null
  };
}

function configuredMonthlyLimit() {
  const value = Number(process.env.AIRTABLE_MONTHLY_API_LIMIT || DEFAULT_MONTHLY_LIMIT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MONTHLY_LIMIT;
}

module.exports = {
  withAirtableUsage,
  currentUsageSnapshot,
  flushCurrentUsage,
  configuredMonthlyLimit,
  currentMonthCaracas,
  isAirtableUrl,
  _test: { persistUsage, safeSource, rawFetch }
};
