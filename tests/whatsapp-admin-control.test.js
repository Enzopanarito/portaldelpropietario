'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const relay = require('../netlify/functions/whatsapp-control.js')._test;
const controller = require('../ops/whatsapp-control/controller.js');

const ROOT = path.join(__dirname, '..');

function parts(hour, minute) {
  return { year: '2026', month: '08', day: '11', hour: String(hour).padStart(2, '0'), minute: String(minute).padStart(2, '0'), second: '00' };
}

test('ventana manual A: 08:00 incluida y 21:00 excluida', () => {
  assert.equal(controller.inAllowedWindow(parts(7, 59)), false);
  assert.equal(controller.inAllowedWindow(parts(8, 0)), true);
  assert.equal(controller.inAllowedWindow(parts(20, 59)), true);
  assert.equal(controller.inAllowedWindow(parts(21, 0)), false);
});

test('horarios automáticos se limitan a 08:00..20:59', () => {
  assert.equal(relay.validSchedule('08:00'), true);
  assert.equal(relay.validSchedule('20:59'), true);
  assert.equal(relay.validSchedule('07:59'), false);
  assert.equal(relay.validSchedule('21:00'), false);
  assert.equal(controller.validSchedule('21:00'), false);
});

test('configuración normaliza, ordena y elimina horarios duplicados', () => {
  const cfg = relay.normalizeConfig({ mode: 'automatic', schedules: ['18:00', '09:00', '09:00'], warmupMinutes: 5 });
  assert.deepEqual(cfg, { mode: 'automatic', schedules: ['09:00', '18:00'], warmupMinutes: 5 });
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

test('frontend no contiene secretos del agente ni toca contratos financieros', () => {
  const edge = fs.readFileSync(path.join(ROOT, 'netlify/edge-functions/admin-whatsapp-control.js'), 'utf8');
  assert.match(edge, /data-target='whatsapp-control'/);
  assert.match(edge, /08:00–21:00/);
  assert.doesNotMatch(edge, /WA_AGENT_TOKEN|AIRTABLE_API_TOKEN|ADMIN_TOKEN_SECRET/);
  assert.doesNotMatch(edge, /monthly-close|admin-manual-payment|process-payment-report|mkj/i);
});

test('relay WhatsApp es independiente de Airtable y exige confirmación manual', () => {
  const source = fs.readFileSync(path.join(ROOT, 'netlify/functions/whatsapp-control.js'), 'utf8');
  assert.doesNotMatch(source, /AIRTABLE_|withAirtableUsage/);
  assert.match(source, /body\.confirm !== 'ENVIAR'/);
  assert.match(source, /requireAdmin\(event\)/);
});

test('controlador no fuerza ciclos artificiales del agente', () => {
  const source = fs.readFileSync(path.join(ROOT, 'ops/whatsapp-control/controller.js'), 'utf8');
  assert.match(source, /forcePlan: false/);
  assert.doesNotMatch(source, /forcePlan: true/);
});
