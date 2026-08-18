import { getStore } from '@netlify/blobs';

const STORE_NAME = 'vla-whatsapp-monitor-v1';
const STATE_KEY = 'state';
const MAX_AGE_MS = (12 * 60 + 30) * 60 * 1000;
const FAILURES_BEFORE_ALERT = 1;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function safeReasons(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 12)
    : [];
}

export default async (req) => {
  if (req.method !== 'GET') return json({ ok: false, status: 'method-not-allowed' }, 405);

  const store = getStore(STORE_NAME, { consistency: 'strong' });
  let state = null;
  try {
    state = await store.get(STATE_KEY, { type: 'json' });
  } catch (_) {
    state = null;
  }

  if (!state?.lastCheckedAt) {
    return json({ ok: false, status: 'monitor-starting', reasons: ['MONITOR_STATE_MISSING'] }, 503);
  }

  const checkedMs = Date.parse(state.lastCheckedAt);
  const ageMs = Number.isFinite(checkedMs) ? Date.now() - checkedMs : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_AGE_MS) {
    return json({
      ok: false,
      status: 'monitor-stale',
      reasons: ['MONITOR_HEARTBEAT_STALE'],
      checkedAt: state.lastCheckedAt
    }, 503);
  }

  const failures = Math.max(0, Number(state.consecutiveFailures || 0));
  const healthy = state.lastHealthStatus === 'operational'
    && state.alertActive !== true
    && failures === 0;

  if (healthy) {
    return json({ ok: true, status: 'operational', checkedAt: state.lastCheckedAt }, 200);
  }

  if (state.alertActive !== true && failures < FAILURES_BEFORE_ALERT) {
    return json({
      ok: true,
      status: 'degraded',
      consecutiveFailures: failures,
      checkedAt: state.lastCheckedAt
    }, 200);
  }

  return json({
    ok: false,
    status: state.lastHealthStatus || 'attention',
    reasons: safeReasons(state.lastReasons),
    consecutiveFailures: failures,
    checkedAt: state.lastCheckedAt
  }, 503);
};
