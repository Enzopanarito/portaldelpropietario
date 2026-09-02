import { getStore } from '@netlify/blobs';

const STORE_NAME = 'vla-whatsapp-manual-send-20260902-v1';
const STATE_KEY = 'state';

function safe(value, max = 220) {
  return String(value ?? '').trim()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted]')
    .slice(0, max);
}
function controller(value = {}) {
  return {
    ok: value?.ok === true,
    mode: safe(value?.mode, 24) || null,
    schedules: Array.isArray(value?.schedules) ? value.schedules.map(v => safe(v, 8)).slice(0, 12) : [],
    warmupMinutes: Number.isFinite(Number(value?.warmupMinutes)) ? Number(value.warmupMinutes) : null,
    agentOk: value?.agentOk === true,
    agentMode: safe(value?.agentMode, 24) || null,
    agentVersion: safe(value?.agentVersion, 40) || null,
    manualSendV136: value?.manualSendV136 === true,
    sessionLinked: value?.sessionLinked === true,
    runInProgress: value?.runInProgress === true,
    lastRunAt: value?.lastRunAt || null,
    lastResult: safe(value?.lastResult, 80) || null,
    lastError: safe(value?.lastError, 220) || null,
    yesterdayEvents: Array.isArray(value?.yesterdayEvents) ? value.yesterdayEvents.map(item => ({
      at: item?.at || null,
      action: safe(item?.action, 48),
      result: safe(item?.result, 48),
      detail: safe(item?.detail, 220)
    })).slice(0, 30) : []
  };
}

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, status: 'method-not-allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  const store = getStore(STORE_NAME, { consistency: 'strong' });
  let state = null;
  try { state = await store.get(STATE_KEY, { type: 'json' }); } catch (_) { state = null; }
  if (!state) {
    return new Response(JSON.stringify({ ok: true, status: 'not-started' }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  const body = {
    ok: state.status === 'done' || state.status === 'done-existing-run',
    status: safe(state.status, 60),
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || null,
    completedAt: state.completedAt || null,
    attempts: Number(state.attempts || 0),
    financial: state.financial ? {
      houses: Number(state.financial.houses || 0),
      accountingMonth: safe(state.financial.accountingMonth, 16),
      transitionPending: state.financial.transitionPending === true,
      balanceEngineVersion: safe(state.financial.balanceEngineVersion, 80) || null,
      generatedAt: state.financial.generatedAt || null,
      financialHash: safe(state.financial.financialHash, 80) || null
    } : null,
    financialAtDispatch: state.financialAtDispatch ? {
      houses: Number(state.financialAtDispatch.houses || 0),
      accountingMonth: safe(state.financialAtDispatch.accountingMonth, 16),
      transitionPending: state.financialAtDispatch.transitionPending === true,
      generatedAt: state.financialAtDispatch.generatedAt || null,
      financialHash: safe(state.financialAtDispatch.financialHash, 80) || null
    } : null,
    controllerBefore: state.controllerBefore ? controller(state.controllerBefore) : null,
    controllerLatest: state.controllerLatest ? controller(state.controllerLatest) : null,
    finalController: state.finalController ? controller(state.finalController) : null,
    queuedAt: state.queuedAt || null,
    result: safe(state.result, 80) || null,
    runDetail: safe(state.runDetail, 220) || null,
    recipientCount: Number.isFinite(Number(state.recipientCount)) ? Number(state.recipientCount) : null,
    restoredMode: safe(state.restoredMode, 24) || null,
    automaticRestored: state.automaticRestored === true,
    lastError: safe(state.lastError, 220) || null
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  });
};
