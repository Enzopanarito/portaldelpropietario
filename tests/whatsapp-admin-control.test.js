'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const relay = require('../netlify/functions/whatsapp-control.js')._test;
const controller = require('../ops/whatsapp-control/controller.js');

const ROOT = path.join(__dirname, '..');

function parts(hour, minute) {
  return {
    year: '2026', month: '08', day: '11',
    hour: String(hour).padStart(2, '0'),
    minute: String(minute).padStart(2, '0'), second: '00'
  };
}

function source(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

test('ventana manual A: 08:00 incluida y 21:00 excluida', () => {
  assert.equal(controller.inAllowedWindow(parts(7, 59)), false);
  assert.equal(controller.inAllowedWindow(parts(8, 0)), true);
  assert.equal(controller.inAllowedWindow(parts(20, 59)), true);
  assert.equal(controller.inAllowedWindow(parts(21, 0)), false);
});

test('1440 minutos del día respetan exactamente la ventana 08:00..20:59', () => {
  for (let minute = 0; minute < 24 * 60; minute++) {
    const hour = Math.floor(minute / 60), mm = minute % 60;
    const expected = minute >= 8 * 60 && minute < 21 * 60;
    assert.equal(controller.inAllowedWindow(parts(hour, mm)), expected, `ventana ${hour}:${mm}`);
    const hhmm = `${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    assert.equal(controller.validSchedule(hhmm), expected, `controller ${hhmm}`);
    assert.equal(relay.validSchedule(hhmm), expected, `relay ${hhmm}`);
  }
});

test('configuración normaliza, ordena y elimina horarios duplicados', () => {
  const cfg = relay.normalizeConfig({ mode: 'automatic', schedules: ['18:00', '09:00', '09:00'], warmupMinutes: 5 });
  assert.deepEqual(cfg, { mode: 'automatic', schedules: ['09:00', '18:00'], warmupMinutes: 5 });
});

test('100 configuraciones válidas consecutivas mantienen orden, unicidad y límites', () => {
  for (let i = 0; i < 100; i++) {
    const h1 = 8 + (i % 12);
    const h2 = 9 + (i % 11);
    const m1 = (i * 7) % 60;
    const m2 = (i * 13) % 60;
    const a = `${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}`;
    const b = `${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}`;
    const cfg = controller.normalizeConfig({ mode: 'automatic', schedules: [b, a, a], warmupMinutes: i % 31 });
    assert.deepEqual(cfg.schedules, [...new Set([b, a])].sort());
    assert.equal(cfg.mode, 'automatic');
    assert.equal(cfg.warmupMinutes, i % 31);
    cfg.schedules.forEach(t => assert.equal(controller.validSchedule(t), true));
  }
});

test('100 entradas inválidas fuera de ventana son rechazadas', () => {
  for (let i = 0; i < 100; i++) {
    const before = `${String(i % 8).padStart(2, '0')}:${String((i * 17) % 60).padStart(2, '0')}`;
    assert.throws(() => controller.normalizeConfig({ mode: 'automatic', schedules: [before], warmupMinutes: 5 }), /08:00 y 20:59/i);
    const afterHour = 21 + (i % 3);
    const after = `${String(afterHour).padStart(2, '0')}:${String((i * 19) % 60).padStart(2, '0')}`;
    assert.throws(() => relay.normalizeConfig({ mode: 'automatic', schedules: [after], warmupMinutes: 5 }), /08:00 y 20:59/i);
  }
});

test('automático no puede quedar sin horarios', () => {
  assert.throws(() => relay.normalizeConfig({ mode: 'automatic', schedules: [], warmupMinutes: 5 }), /requiere al menos un horario/i);
  assert.throws(() => controller.normalizeConfig({ mode: 'automatic', schedules: [], warmupMinutes: 5 }), /requiere al menos un horario/i);
});

test('manual y pausado pueden conservar control sin disparos automáticos', () => {
  assert.equal(controller.normalizeConfig({ mode: 'manual', schedules: [], warmupMinutes: 5 }).mode, 'manual');
  assert.equal(controller.normalizeConfig({ mode: 'paused', schedules: [], warmupMinutes: 5 }).mode, 'paused');
});

test('precalentamiento admite hasta 30 minutos y puede ocurrir antes de 08:00', () => {
  assert.equal(controller.shiftMinutes('08:00', -5), '07:55');
  assert.equal(controller.normalizeConfig({ mode: 'automatic', schedules: ['08:00'], warmupMinutes: 30 }).warmupMinutes, 30);
  assert.throws(() => controller.normalizeConfig({ mode: 'automatic', schedules: ['08:00'], warmupMinutes: 31 }), /Precalentamiento inválido/i);
});

test('100 desplazamientos de warmup conservan aritmética exacta', () => {
  for (let i = 0; i < 100; i++) {
    const hour = 8 + (i % 13);
    const minute = (i * 11) % 60;
    const delta = -(i % 31);
    const input = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const total = hour * 60 + minute + delta;
    const expected = total < 0 ? null : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    assert.equal(controller.shiftMinutes(input, delta), expected);
  }
});

test('bootstrap del controlador es PAUSADO para instalación segura', () => {
  const bootstrap = JSON.parse(source('ops/whatsapp-control/bootstrap-control.json'));
  assert.equal(bootstrap.mode, 'paused');
  assert.deepEqual(bootstrap.schedules, ['09:00', '18:00']);
  assert.equal(controller.DEFAULT_CONFIG.mode, 'paused');
});

test('controlador encola run y warmup, serializa operaciones y limita reintentos', () => {
  const text = source('ops/whatsapp-control/controller.js');
  assert.match(text, /forcePlan: false/);
  assert.doesNotMatch(text, /forcePlan: true/);
  assert.match(text, /queueRun/);
  assert.match(text, /queueWarmup/);
  assert.match(text, /runInProgress/);
  assert.match(text, /warmupInProgress/);
  assert.match(text, /retryAt/);
  assert.match(text, /superseded/);
  assert.equal(controller.RETRY_MS, 5 * 60 * 1000);
});

test('frontend unifica Comunicaciones/WhatsApp y no expone secretos ni mutaciones financieras', () => {
  const edge = source('netlify/edge-functions/admin-whatsapp-control.js');
  assert.match(edge, /data-target='whatsapp-control'/);
  assert.match(edge, /href=\"\/whatsapp\.html\"/);
  assert.match(edge, /data-wa-control/);
  assert.match(edge, /#whatsapp-control/);
  assert.match(edge, /08:00–21:00/);
  assert.doesNotMatch(edge, /WA_AGENT_TOKEN|AIRTABLE_API_TOKEN|ADMIN_TOKEN_SECRET|PAYMENT_PROOF_ENCRYPTION_KEY/);
  assert.doesNotMatch(edge, /monthly-close|admin-manual-payment|process-payment-report|mkj/i);
});

test('whatsapp.html antiguo ya no crea órdenes: solo conduce al control único', () => {
  const html = source('whatsapp.html');
  assert.match(html, /admin\.html#whatsapp-control/);
  assert.match(html, /Control WhatsApp integrado/);
  assert.doesNotMatch(html, /create-job|create-schedule|whatsapp-jobs|job-force|run-scheduler/);
});

test('backend histórico whatsapp-jobs queda conservado e independiente', () => {
  const oldBackend = source('netlify/functions/whatsapp-jobs.js');
  assert.match(oldBackend, /WhatsApp Jobs/);
  assert.match(oldBackend, /WhatsApp Programaciones/);
  assert.match(oldBackend, /requireAdmin/);
});

test('relay WhatsApp nuevo es independiente de Airtable y exige confirmación manual', () => {
  const text = source('netlify/functions/whatsapp-control.js');
  assert.doesNotMatch(text, /AIRTABLE_|withAirtableUsage/);
  assert.match(text, /body\.confirm !== 'ENVIAR'/);
  assert.match(text, /requireAdmin\(event\)/);
  assert.match(text, /VLA_WHATSAPP_CONTROL_URL/);
  assert.match(text, /VLA_WHATSAPP_CONTROL_SECRET/);
  assert.match(text, /X-VLA-Control-Secret/);
  assert.doesNotMatch(text, /WA_AGENT_TOKEN/);
});

test('gateway n8n nace inactivo, usa dos Header Auth y no contiene secretos reales', () => {
  const file = path.join(ROOT, 'ops/whatsapp-control/n8n/VLA_WhatsApp_Admin_Gateway_v1.template.json');
  const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(workflow.active, false);
  const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  const http = workflow.nodes.find(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.equal(http.parameters.url, 'http://whatsapp-controller:8788/control');
  assert.equal(http.parameters.authentication, 'genericCredentialType');
  assert.equal(http.parameters.genericAuthType, 'httpHeaderAuth');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /__VLA_CONTROL_HEADER_CREDENTIAL_ID__/);
  assert.match(raw, /__WA_AGENT_HEADER_CREDENTIAL_ID__/);
  assert.doesNotMatch(raw, /NGROK_AUTHTOKEN|WA_AGENT_TOKEN=|sk-[A-Za-z0-9_-]+/);
});

test('controlador solo expone diagnóstico en loopback del Mac', () => {
  const compose = source('ops/whatsapp-control/docker-compose.whatsapp-control.yml');
  assert.match(compose, /127\.0\.0\.1:8788:8788/);
  assert.doesNotMatch(compose, /^\s*-\s*["']?8788:8788/m);
});

test('Netlify registra una sola capa WhatsApp después del middleware admin existente', () => {
  const toml = source('netlify.toml');
  const matches = toml.match(/function\s*=\s*"admin-whatsapp-control"/g) || [];
  assert.equal(matches.length, 1);
  const closeAt = toml.indexOf('function = "admin-monthly-close"');
  const waAt = toml.indexOf('function = "admin-whatsapp-control"');
  assert.ok(closeAt >= 0 && waAt > closeAt);
  for (const existing of ['pwa-head', 'admin-premium-assets', 'admin-auth-version', 'owner-mobile-assets', 'owner-signature', 'admin-links', 'admin-monthly-close']) {
    assert.match(toml, new RegExp(`function\\s*=\\s*"${existing}"`));
  }
});

test('100 ciclos de normalización relay/controlador producen el mismo contrato', () => {
  for (let i = 0; i < 100; i++) {
    const hour = 8 + (i % 13);
    const minute = (i * 23) % 60;
    const t = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const warm = i % 31;
    const a = relay.normalizeConfig({ mode: 'automatic', schedules: [t, '18:00', t], warmupMinutes: warm });
    const b = controller.normalizeConfig({ mode: 'automatic', schedules: [t, '18:00', t], warmupMinutes: warm });
    assert.equal(b.mode, a.mode);
    assert.deepEqual(b.schedules, a.schedules);
    assert.equal(b.warmupMinutes, a.warmupMinutes);
  }
});

test('100 inspecciones estáticas confirman que no aparece un secreto literal ni forcePlan true', () => {
  const joined = [
    source('netlify/functions/whatsapp-control.js'),
    source('netlify/edge-functions/admin-whatsapp-control.js'),
    source('ops/whatsapp-control/controller.js'),
    source('ops/whatsapp-control/n8n/VLA_WhatsApp_Admin_Gateway_v1.template.json')
  ].join('\n');
  for (let i = 0; i < 100; i++) {
    assert.doesNotMatch(joined, /NGROK_AUTHTOKEN\s*=|WA_AGENT_TOKEN\s*=\s*[A-Fa-f0-9]{32,}|forcePlan\s*:\s*true/);
  }
});
