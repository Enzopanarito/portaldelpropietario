import { randomUUID } from 'node:crypto';

const EXPECTED_SCHEDULES = Object.freeze(['09:00', '18:00']);
const REASON_LABELS = Object.freeze({
  MONITOR_CONFIG_MISSING: 'El monitor externo no tiene configurado el puente seguro.',
  MAC_OR_GATEWAY_UNREACHABLE: 'La Mac mini, n8n o el gateway externo no respondieron.',
  CONTROLLER_NOT_OK: 'El Controller de WhatsApp no reporta estado saludable.',
  AGENT_NOT_OK: 'El Agent de WhatsApp no reporta estado saludable.',
  AGENT_NOT_REAL: 'El Agent no está en modo REAL.',
  AGENT_READINESS_MISSING: 'El Agent responde, pero no entregó una prueba de preparación real de WhatsApp.',
  AGENT_READINESS_NOT_HEALTHY: 'El Agent está vivo, pero WhatsApp no está realmente listo para enviar.',
  SESSION_NOT_LINKED: 'La sesión de WhatsApp no aparece vinculada.',
  MODE_NOT_AUTOMATIC: 'El Controller no está en modo AUTOMATIC.',
  SCHEDULE_DRIFT: 'Los horarios configurados ya no son 09:00 y 18:00.',
  WARMUP_DRIFT: 'El warmup configurado ya no es de 5 minutos.',
  RUNTIME_ERROR: 'El runtime de WhatsApp reporta un error activo.'
});

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeSchedules(value) {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))].sort() : [];
}

function sameSchedules(left, right = EXPECTED_SCHEDULES) {
  const a = normalizeSchedules(left);
  const b = normalizeSchedules(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function readinessFrom(data = {}, agent = {}) {
  const direct = data?.readiness && typeof data.readiness === 'object' ? data.readiness : null;
  const nested = agent?.readiness && typeof agent.readiness === 'object' ? agent.readiness : null;
  return direct || nested;
}

function evaluateStatus(data = {}) {
  const config = data?.config && typeof data.config === 'object' ? data.config : {};
  const agent = data?.agent && typeof data.agent === 'object' ? data.agent : {};
  const session = data?.session && typeof data.session === 'object' ? data.session : {};
  const runtime = data?.runtime && typeof data.runtime === 'object' ? data.runtime : {};
  const readiness = readinessFrom(data, agent);
  const reasons = [];

  if (data?.ok !== true) reasons.push('CONTROLLER_NOT_OK');
  if (agent.ok === false) reasons.push('AGENT_NOT_OK');
  if (clean(agent.mode).toLowerCase() !== 'real') reasons.push('AGENT_NOT_REAL');
  if (!readiness) reasons.push('AGENT_READINESS_MISSING');
  else if (readiness.ready !== true || clean(readiness.code).toUpperCase() !== 'READY') reasons.push('AGENT_READINESS_NOT_HEALTHY');
  if (session.loggedIn !== true) reasons.push('SESSION_NOT_LINKED');
  if (clean(config.mode).toLowerCase() !== 'automatic') reasons.push('MODE_NOT_AUTOMATIC');
  if (!sameSchedules(config.schedules)) reasons.push('SCHEDULE_DRIFT');
  if (Number(config.warmupMinutes) !== 5) reasons.push('WARMUP_DRIFT');
  if (clean(runtime.lastError)) reasons.push('RUNTIME_ERROR');

  return {
    healthy: reasons.length === 0,
    status: reasons.length === 0 ? 'operational' : 'attention',
    reasons,
    components: {
      controller: data?.ok === true,
      agent: agent.ok !== false && clean(agent.mode).toLowerCase() === 'real',
      readiness: Boolean(readiness && readiness.ready === true && clean(readiness.code).toUpperCase() === 'READY'),
      readinessCode: clean(readiness?.code) || null,
      whatsappSession: session.loggedIn === true,
      automatic: clean(config.mode).toLowerCase() === 'automatic',
      schedule: sameSchedules(config.schedules),
      warmup: Number(config.warmupMinutes) === 5,
      runtimeError: Boolean(clean(runtime.lastError)),
      runInProgress: runtime.runInProgress === true,
      warmupInProgress: runtime.warmupInProgress === true
    }
  };
}

function unreachableHealth(reason = 'MAC_OR_GATEWAY_UNREACHABLE') {
  return {
    healthy: false,
    status: 'offline',
    reasons: [reason],
    components: {
      controller: false,
      agent: false,
      readiness: false,
      readinessCode: null,
      whatsappSession: false,
      automatic: false,
      schedule: false,
      warmup: false,
      runtimeError: false,
      runInProgress: false,
      warmupInProgress: false
    }
  };
}

async function relayStatus({ url, secret, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const endpoint = clean(url);
  const token = clean(secret);
  if (!/^https:\/\//i.test(endpoint) || Buffer.byteLength(token, 'utf8') < 32) {
    const error = new Error('MONITOR_CONFIG_MISSING');
    error.code = 'MONITOR_CONFIG_MISSING';
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-VLA-Control-Secret': token,
        'User-Agent': 'VLA-External-WhatsApp-Monitor/1.1'
      },
      body: JSON.stringify({
        action: 'status',
        payload: {},
        requestId: randomUUID(),
        requestedAt: new Date().toISOString()
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`GATEWAY_HTTP_${response.status}`);
      error.code = 'MAC_OR_GATEWAY_UNREACHABLE';
      throw error;
    }
    return data;
  } catch (error) {
    if (!error.code) error.code = 'MAC_OR_GATEWAY_UNREACHABLE';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultState() {
  return {
    version: 2,
    alertActive: false,
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
    lastHealthyAt: null,
    alertSentAt: null,
    lastReminderAt: null,
    recoverySentAt: null,
    lastReasons: []
  };
}

function planTransition(previous = {}, health, nowMs = Date.now(), { failuresBeforeAlert = 2, reminderMs = 12 * 60 * 60 * 1000 } = {}) {
  const prior = { ...defaultState(), ...(previous || {}) };
  const nowIso = new Date(nowMs).toISOString();

  if (health?.healthy === true) {
    return {
      action: prior.alertActive ? 'recovery' : 'none',
      next: {
        ...prior,
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
        lastHealthyAt: nowIso,
        lastReasons: []
      }
    };
  }

  const failures = Math.max(0, Number(prior.consecutiveFailures || 0)) + 1;
  const next = {
    ...prior,
    consecutiveFailures: failures,
    firstFailureAt: prior.firstFailureAt || nowIso,
    lastFailureAt: nowIso,
    lastReasons: Array.isArray(health?.reasons) ? health.reasons.slice(0, 12) : []
  };

  if (!prior.alertActive && failures >= failuresBeforeAlert) return { action: 'alert', next };
  if (prior.alertActive) {
    const lastReminderMs = Date.parse(prior.lastReminderAt || prior.alertSentAt || '');
    if (!Number.isFinite(lastReminderMs) || nowMs - lastReminderMs >= reminderMs) return { action: 'reminder', next };
  }
  return { action: 'none', next };
}

function reasonText(reasons = []) {
  const unique = [...new Set((Array.isArray(reasons) ? reasons : []).map(clean).filter(Boolean))];
  return unique.map(code => REASON_LABELS[code] || code);
}

export {
  EXPECTED_SCHEDULES,
  REASON_LABELS,
  clean,
  normalizeSchedules,
  sameSchedules,
  readinessFrom,
  evaluateStatus,
  unreachableHealth,
  relayStatus,
  defaultState,
  planTransition,
  reasonText
};