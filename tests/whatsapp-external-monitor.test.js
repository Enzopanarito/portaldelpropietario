'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(ROOT, 'netlify/functions/_shared/_whatsapp_external_monitor.mjs');
let monitor;

test.before(async () => {
  monitor = await import(pathToFileURL(MODULE).href);
});

function healthyStatus(overrides = {}) {
  return {
    ok: true,
    config: { mode: 'automatic', schedules: ['09:00', '18:00'], warmupMinutes: 5 },
    agent: { ok: true, mode: 'real' },
    readiness: { ready: true, code: 'READY', loggedIn: true, observedAt: '2026-09-03T17:42:33.359Z' },
    session: { loggedIn: true },
    runtime: { lastError: '', runInProgress: false, warmupInProgress: false },
    ...overrides
  };
}

test('healthy status is operational only with real readiness evidence', () => {
  const result = monitor.evaluateStatus(healthyStatus());
  assert.equal(result.healthy, true);
  assert.equal(result.status, 'operational');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.components.readiness, true);
});

test('missing readiness cannot be reported green', () => {
  const status = healthyStatus();
  delete status.readiness;
  const result = monitor.evaluateStatus(status);
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes('AGENT_READINESS_MISSING'));
});

test('alive Agent with unhealthy readiness cannot be reported green', () => {
  const result = monitor.evaluateStatus(healthyStatus({
    readiness: { ready: false, code: 'BROWSER_DATABASE_ERROR', loggedIn: false }
  }));
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes('AGENT_READINESS_NOT_HEALTHY'));
  assert.equal(result.components.readiness, false);
  assert.equal(result.components.readinessCode, 'BROWSER_DATABASE_ERROR');
});

test('paused controller requires attention', () => {
  const result = monitor.evaluateStatus(healthyStatus({
    config: { mode: 'paused', schedules: ['09:00', '18:00'], warmupMinutes: 5 }
  }));
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes('MODE_NOT_AUTOMATIC'));
});

test('unlinked WhatsApp session requires attention', () => {
  const result = monitor.evaluateStatus(healthyStatus({ session: { loggedIn: false } }));
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.includes('SESSION_NOT_LINKED'));
});

test('schedule and warmup drift are detected', () => {
  const result = monitor.evaluateStatus(healthyStatus({
    config: { mode: 'automatic', schedules: ['09:00'], warmupMinutes: 10 }
  }));
  assert.ok(result.reasons.includes('SCHEDULE_DRIFT'));
  assert.ok(result.reasons.includes('WARMUP_DRIFT'));
});

test('runtime error is detected', () => {
  const result = monitor.evaluateStatus(healthyStatus({ runtime: { lastError: 'gateway failed' } }));
  assert.ok(result.reasons.includes('RUNTIME_ERROR'));
});

test('relay is strictly read-only and sends status action only', async () => {
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => healthyStatus() };
  };
  const result = await monitor.relayStatus({
    url: 'https://gateway.example.test/webhook/vla-whatsapp-control-v1',
    secret: 'x'.repeat(64),
    fetchImpl: fakeFetch,
    timeoutMs: 1000
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(request.options.body);
  assert.equal(body.action, 'status');
  assert.deepEqual(body.payload, {});
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-VLA-Control-Secret'], 'x'.repeat(64));
});

test('relay fails closed when monitor credentials are not configured', async () => {
  await assert.rejects(
    () => monitor.relayStatus({ url: 'http://insecure.test', secret: 'short', fetchImpl: async () => null }),
    error => error?.code === 'MONITOR_CONFIG_MISSING'
  );
});

test('two-review policy avoids alert on one transient failure', () => {
  const health = monitor.unreachableHealth();
  const first = monitor.planTransition(
    monitor.defaultState(),
    health,
    Date.parse('2026-09-03T12:00:00Z'),
    { failuresBeforeAlert: 2, reminderMs: 12 * 60 * 60 * 1000 }
  );
  assert.equal(first.action, 'none');
  assert.equal(first.next.consecutiveFailures, 1);

  const second = monitor.planTransition(
    first.next,
    health,
    Date.parse('2026-09-03T12:15:00Z'),
    { failuresBeforeAlert: 2, reminderMs: 12 * 60 * 60 * 1000 }
  );
  assert.equal(second.action, 'alert');
  assert.equal(second.next.consecutiveFailures, 2);
});

test('active incident does not spam before 12 hours', () => {
  const health = monitor.unreachableHealth();
  const state = {
    ...monitor.defaultState(),
    alertActive: true,
    consecutiveFailures: 2,
    alertSentAt: '2026-09-03T12:00:00.000Z',
    lastReminderAt: '2026-09-03T12:00:00.000Z'
  };
  const transition = monitor.planTransition(state, health, Date.parse('2026-09-03T13:00:00Z'));
  assert.equal(transition.action, 'none');
});

test('active incident emits reminder after 12 hours', () => {
  const health = monitor.unreachableHealth();
  const state = {
    ...monitor.defaultState(),
    alertActive: true,
    consecutiveFailures: 2,
    alertSentAt: '2026-09-03T12:00:00.000Z',
    lastReminderAt: '2026-09-03T12:00:00.000Z'
  };
  const transition = monitor.planTransition(state, health, Date.parse('2026-09-04T00:01:00Z'));
  assert.equal(transition.action, 'reminder');
});

test('healthy state after alert emits a single recovery action', () => {
  const state = {
    ...monitor.defaultState(),
    alertActive: true,
    consecutiveFailures: 2,
    alertSentAt: '2026-09-03T12:00:00.000Z'
  };
  const transition = monitor.planTransition(state, { healthy: true }, Date.parse('2026-09-04T00:00:00Z'));
  assert.equal(transition.action, 'recovery');
  assert.equal(transition.next.consecutiveFailures, 0);
});

test('monitor source never invokes mutating WhatsApp actions', () => {
  const shared = fs.readFileSync(MODULE, 'utf8');
  const scheduled = fs.readFileSync(path.join(ROOT, 'netlify/functions/whatsapp-external-monitor.mjs'), 'utf8');
  const combined = `${shared}\n${scheduled}`;
  for (const forbidden of ['run-now', 'warmup', 'pause', 'resume', 'relink']) {
    assert.equal(new RegExp(`action\\s*:\\s*['\"]${forbidden}['\"]`, 'i').test(combined), false, forbidden);
  }
  assert.match(shared, /action:\s*'status'/);
});

test('monitor checks every 15m, public health expires at 25m and GitHub watchdog checks every 30m', () => {
  const scheduled = fs.readFileSync(path.join(ROOT, 'netlify/functions/whatsapp-external-monitor.mjs'), 'utf8');
  const health = fs.readFileSync(path.join(ROOT, 'netlify/functions/whatsapp-external-health.mjs'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/monitor-whatsapp-external.yml'), 'utf8');
  assert.match(scheduled, /schedule:\s*'\*\/15 \* \* \* \*'/);
  assert.match(scheduled, /FAILURES_BEFORE_ALERT = 2/);
  assert.match(health, /FAILURES_BEFORE_ALERT = 2/);
  assert.match(health, /MAX_AGE_MS = 25 \* 60 \* 1000/);
  assert.match(workflow, /cron:\s*'7,37 \* \* \* \*'/);
  assert.match(health, /getStore\(STORE_NAME/);
  assert.doesNotMatch(health, /VLA_WHATSAPP_CONTROL_SECRET|relayStatus|X-VLA-Control-Secret/);
});