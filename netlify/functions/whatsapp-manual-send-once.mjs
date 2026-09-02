import { getStore } from '@netlify/blobs';
import { createHash, randomUUID } from 'node:crypto';

const STORE_NAME = 'vla-whatsapp-manual-send-20260902-v1';
const STATE_KEY = 'state';
const TARGET_DAY = '2026-09-02';
const PUBLIC_URL = 'https://villalosapamates.netlify.app/api/vla/public-data';
const EXPECTED_HOUSES = 15;
const MAX_RETRIES = 5;
const NUMERIC_FIELDS = [
  'saldoUsd','saldoBsRef','totalPagadero','saldoNetoReferencial','saldoFavorUsd','saldoFavorBs',
  'deudaVencidaUsd','deudaVencidaBs','mesCorrienteUsd','mesCorrienteBs'
];

function nowIso() { return new Date().toISOString(); }
function clean(value) { return String(value ?? '').trim(); }
function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function env(name) { return clean(Netlify.env.get(name)); }
function caracasDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function safeText(value, max = 220) {
  return clean(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted]')
    .slice(0, max);
}
function sanitizeHistory(history = []) {
  const start = Date.parse('2026-09-01T20:00:00Z');
  const end = Date.parse('2026-09-02T04:00:00Z');
  return (Array.isArray(history) ? history : [])
    .filter(item => {
      const at = Date.parse(item?.at || '');
      return Number.isFinite(at) && at >= start && at <= end;
    })
    .slice(0, 30)
    .map(item => ({
      at: item.at || null,
      action: safeText(item.action, 48),
      result: safeText(item.result, 48),
      detail: safeText(item.detail, 220)
    }));
}
function controllerSummary(data = {}) {
  const config = data?.config || {};
  const agent = data?.agent || {};
  const runtime = data?.runtime || {};
  return {
    ok: data?.ok === true,
    mode: clean(config.mode).toLowerCase(),
    schedules: Array.isArray(config.schedules) ? config.schedules.map(clean).filter(Boolean).slice(0, 12) : [],
    warmupMinutes: Number(config.warmupMinutes ?? 5),
    agentOk: agent.ok !== false,
    agentMode: clean(agent.mode).toLowerCase(),
    agentVersion: safeText(agent.version, 40) || null,
    manualSendV136: agent?.capabilities?.manualSendV136 === true,
    sessionLinked: data?.session?.loggedIn === true,
    runInProgress: runtime.runInProgress === true,
    lastRunAt: runtime.lastRunAt || null,
    lastResult: safeText(runtime.lastResult, 80) || null,
    lastError: safeText(runtime.lastError, 220) || null,
    yesterdayEvents: sanitizeHistory(data?.history)
  };
}
async function relay(action, payload = {}, timeoutMs = 8000) {
  const url = env('VLA_WHATSAPP_CONTROL_URL');
  const secret = env('VLA_WHATSAPP_CONTROL_SECRET');
  if (!/^https:\/\//i.test(url) || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('CONTROL_CONFIG_MISSING');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-VLA-Control-Secret': secret,
        'User-Agent': 'VLA-WhatsApp-Manual-Send-Once/1.0'
      },
      body: JSON.stringify({ action, payload, requestId: randomUUID(), requestedAt: nowIso() }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeText(data?.message || data?.error || `GATEWAY_HTTP_${response.status}`));
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchPublicData(timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${PUBLIC_URL}?force=1&whatsapp_preflight=${Date.now()}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'VLA-WhatsApp-Manual-Preflight/1.0' },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`PUBLIC_HTTP_${response.status}:${safeText(data?.code || data?.message, 120)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}
function validateFinancial(data = {}) {
  const owners = Array.isArray(data.propietarios) ? data.propietarios : [];
  if (owners.length !== EXPECTED_HOUSES) throw new Error(`FINANCIAL_HOUSES_${owners.length}`);
  const houses = owners.map(owner => Number(owner?.Casa)).sort((a,b) => a-b);
  for (let i = 0; i < EXPECTED_HOUSES; i += 1) {
    if (houses[i] !== i + 1) throw new Error('FINANCIAL_HOUSE_SEQUENCE');
  }
  if (data?.accountingTransition?.pending === true) throw new Error('FINANCIAL_TRANSITION_PENDING');
  const accountingMonth = clean(data?.accountingTransition?.accountingMonth || data?.accountingTransition?.calendarMonth);
  if (accountingMonth && accountingMonth !== '2026-09') throw new Error(`FINANCIAL_MONTH_${accountingMonth}`);

  const canonical = owners.map(owner => {
    for (const field of NUMERIC_FIELDS) {
      if (!Number.isFinite(Number(owner?.[field]))) throw new Error(`FINANCIAL_NONFINITE_C${owner?.Casa}_${field}`);
    }
    const saldoUsd = round2(owner.saldoUsd);
    const saldoBsRef = round2(owner.saldoBsRef);
    const totalPagadero = round2(owner.totalPagadero);
    const expectedTotal = round2(Math.max(0, saldoUsd) + Math.max(0, saldoBsRef));
    if (Math.abs(totalPagadero - expectedTotal) > 0.01) throw new Error(`FINANCIAL_TOTAL_C${owner.Casa}`);
    if (Math.abs(round2(owner.saldoFavorUsd) - round2(Math.max(0, -saldoUsd))) > 0.01) throw new Error(`FINANCIAL_CREDIT_USD_C${owner.Casa}`);
    if (Math.abs(round2(owner.saldoFavorBs) - round2(Math.max(0, -saldoBsRef))) > 0.01) throw new Error(`FINANCIAL_CREDIT_BS_C${owner.Casa}`);
    return {
      Casa: Number(owner.Casa), saldoUsd, saldoBsRef, totalPagadero,
      saldoFavorUsd: round2(owner.saldoFavorUsd), saldoFavorBs: round2(owner.saldoFavorBs),
      deudaVencidaUsd: round2(owner.deudaVencidaUsd), deudaVencidaBs: round2(owner.deudaVencidaBs),
      mesCorrienteUsd: round2(owner.mesCorrienteUsd), mesCorrienteBs: round2(owner.mesCorrienteBs)
    };
  }).sort((a,b) => a.Casa - b.Casa);
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return {
    houses: owners.length,
    accountingMonth: accountingMonth || '2026-09',
    transitionPending: false,
    balanceEngineVersion: safeText(data.balanceEngineVersion, 80) || null,
    generatedAt: data.generatedAt || null,
    financialHash: hash
  };
}
async function readState(store) {
  try { return (await store.get(STATE_KEY, { type: 'json' })) || null; }
  catch (_) { return null; }
}
async function writeState(store, state) {
  const next = { ...state, updatedAt: nowIso() };
  await store.setJSON(STATE_KEY, next);
  return next;
}
function latestRun(history = [], since = '') {
  const sinceMs = Date.parse(since || '');
  return (Array.isArray(history) ? history : [])
    .filter(item => clean(item?.action).toLowerCase() === 'run')
    .find(item => {
      const at = Date.parse(item?.at || '');
      return Number.isFinite(at) && (!Number.isFinite(sinceMs) || at >= sinceMs - 2000);
    }) || null;
}
function recipientCountFromDetail(detail = '') {
  const match = /destinatarios\s*=\s*(\d+)/i.exec(clean(detail));
  return match ? Number(match[1]) : null;
}
function retryState(state, error) {
  const attempts = Number(state?.attempts || 0) + 1;
  return {
    ...state,
    attempts,
    status: attempts >= MAX_RETRIES ? 'failed' : (state?.status || 'retry'),
    lastError: safeText(error?.message || error, 220)
  };
}

export default async () => {
  const store = getStore(STORE_NAME, { consistency: 'strong' });
  let state = await readState(store) || {
    version: 1,
    status: 'new',
    createdAt: nowIso(),
    attempts: 0,
    targetDay: TARGET_DAY
  };

  if (['done','done-existing-run','failed','blocked-financial','blocked-controller'].includes(state.status)) {
    return new Response(JSON.stringify({ ok: state.status.startsWith('done'), status: state.status }), { status: 200 });
  }
  if (caracasDay() !== TARGET_DAY) {
    state = await writeState(store, { ...state, status: 'failed', lastError: 'TARGET_DAY_EXPIRED' });
    return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
  }

  try {
    if (state.status === 'new' || state.status === 'retry') {
      let financial;
      try { financial = validateFinancial(await fetchPublicData()); }
      catch (error) {
        const message = safeText(error?.message || error, 220);
        const transient = /PUBLIC_HTTP_|AbortError|aborted|fetch/i.test(message);
        if (!transient) {
          state = await writeState(store, { ...state, status: 'blocked-financial', lastError: message });
          return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
        }
        state = await writeState(store, retryState({ ...state, status: 'retry' }, error));
        return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
      }

      const rawStatus = await relay('status');
      const summary = controllerSummary(rawStatus);
      state = {
        ...state,
        attempts: 0,
        financial,
        controllerBefore: summary,
        originalConfig: {
          mode: summary.mode,
          schedules: summary.schedules,
          warmupMinutes: summary.warmupMinutes
        },
        observedAt: nowIso()
      };

      if (!summary.ok || !summary.agentOk || summary.agentMode !== 'real' || !summary.sessionLinked) {
        state = await writeState(store, { ...state, status: 'blocked-controller', lastError: summary.lastError || 'CONTROLLER_OR_SESSION_NOT_READY' });
        return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
      }
      if (!summary.manualSendV136) {
        state = await writeState(store, { ...state, status: 'blocked-controller', lastError: `MANUAL_SEND_V136_MISSING:${summary.agentVersion || 'unknown'}` });
        return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
      }
      if (summary.runInProgress) {
        state = await writeState(store, { ...state, status: 'waiting-existing-run', existingRunObservedAt: nowIso(), existingLastRunAt: summary.lastRunAt });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      if (summary.mode === 'paused') {
        await relay('set-config', {
          mode: 'manual',
          schedules: summary.schedules,
          warmupMinutes: summary.warmupMinutes
        });
        state = await writeState(store, { ...state, status: 'armed', temporarilyManual: true });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      if (!['automatic','manual'].includes(summary.mode)) {
        state = await writeState(store, { ...state, status: 'blocked-controller', lastError: `UNSUPPORTED_MODE:${summary.mode}` });
        return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
      }
      state = await writeState(store, { ...state, status: 'armed', temporarilyManual: false });
      return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
    }

    if (state.status === 'waiting-existing-run') {
      const rawStatus = await relay('status');
      const summary = controllerSummary(rawStatus);
      if (summary.runInProgress) {
        state = await writeState(store, { ...state, controllerLatest: summary });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      const lastMs = Date.parse(summary.lastRunAt || '');
      const observedMs = Date.parse(state.existingRunObservedAt || '');
      if (Number.isFinite(lastMs) && Number.isFinite(observedMs) && lastMs >= observedMs - 2000 && !summary.lastError) {
        state = await writeState(store, {
          ...state, status: 'done-existing-run', completedAt: summary.lastRunAt || nowIso(),
          result: summary.lastResult || 'existing-run-completed', controllerLatest: summary
        });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      state = await writeState(store, { ...state, status: 'armed', controllerLatest: summary });
      return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
    }

    if (state.status === 'armed') {
      const financial = validateFinancial(await fetchPublicData());
      const queuedAt = nowIso();
      const result = await relay('run-now', { source: 'admin-manual' });
      const requestId = result?.queued?.requestId || null;
      if (result?.queued?.accepted !== true || !requestId) throw new Error('RUN_NOT_QUEUED');
      state = await writeState(store, {
        ...state, status: 'queued', attempts: 0, financialAtDispatch: financial,
        queuedAt: result?.queued?.startedAt || queuedAt, queuedRequestId: requestId
      });
      return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
    }

    if (state.status === 'queued') {
      const rawStatus = await relay('status');
      const summary = controllerSummary(rawStatus);
      const runEvent = latestRun(rawStatus?.history, state.queuedAt);
      if (summary.runInProgress) {
        state = await writeState(store, { ...state, controllerLatest: summary });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      const lastRunMs = Date.parse(summary.lastRunAt || '');
      const queuedMs = Date.parse(state.queuedAt || '');
      const eventResult = clean(runEvent?.result).toUpperCase();
      if (eventResult === 'ERROR' || summary.lastError) {
        state = await writeState(store, {
          ...state, status: 'failed', completedAt: nowIso(),
          lastError: safeText(runEvent?.detail || summary.lastError || 'RUN_FAILED'), controllerLatest: summary
        });
        return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
      }
      if (Number.isFinite(lastRunMs) && Number.isFinite(queuedMs) && lastRunMs >= queuedMs - 2000) {
        state = await writeState(store, {
          ...state,
          status: 'needs-restore',
          completedAt: summary.lastRunAt || nowIso(),
          result: safeText(runEvent?.result || summary.lastResult || 'OK', 80),
          runDetail: safeText(runEvent?.detail, 220) || null,
          recipientCount: recipientCountFromDetail(runEvent?.detail),
          controllerLatest: summary
        });
        return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
      }
      state = await writeState(store, retryState(state, new Error('RUN_COMPLETION_NOT_OBSERVED')));
      return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
    }

    if (state.status === 'needs-restore' || state.status === 'sent-restore-pending') {
      const original = state.originalConfig || {};
      const restoreMode = original.mode === 'manual' ? 'manual' : 'automatic';
      await relay('set-config', {
        mode: restoreMode,
        schedules: Array.isArray(original.schedules) && original.schedules.length ? original.schedules : ['09:00','18:00'],
        warmupMinutes: Number.isInteger(Number(original.warmupMinutes)) ? Number(original.warmupMinutes) : 5
      });
      const finalStatus = controllerSummary(await relay('status'));
      state = await writeState(store, {
        ...state, status: 'done', restoredMode: restoreMode, automaticRestored: restoreMode === 'automatic',
        finalController: finalStatus, lastError: null
      });
      return new Response(JSON.stringify({ ok: true, status: state.status }), { status: 200 });
    }

    state = await writeState(store, { ...state, status: 'failed', lastError: `UNKNOWN_STATE:${safeText(state.status, 80)}` });
    return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
  } catch (error) {
    const next = retryState(state, error);
    if (state.status === 'needs-restore') next.status = next.attempts >= MAX_RETRIES ? 'failed' : 'sent-restore-pending';
    state = await writeState(store, next);
    console.error(`VLA_WHATSAPP_MANUAL_SEND_ONCE status=${state.status} error=${safeText(error?.message || error, 180)}`);
    return new Response(JSON.stringify({ ok: false, status: state.status }), { status: 200 });
  }
};

export const config = {
  schedule: '* * * * *'
};
