'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('disparador manual refresca el ciclo vigente sin cambiar el automático', () => {
  const controller = read('ops/whatsapp-control/controller.js');

  assert.match(controller, /VLA_MANUAL_CYCLE_TRIGGER_V1/);
  assert.match(controller, /MANUAL_FORCE_PLAN\s*=\s*true/);
  assert.match(controller, /AUTOMATIC_RUN_OPTIONS\s*=\s*Object\.freeze\(\{\s*forcePlan:\s*false\s*\}\)/);
  assert.match(controller, /MANUAL_RUN_OPTIONS\s*=\s*Object\.freeze\(\{\s*forcePlan:\s*MANUAL_FORCE_PLAN\s*\}\)/);
  assert.match(controller, /function queueRun\(reason = 'admin-manual', options = MANUAL_RUN_OPTIONS\)/);
  assert.match(controller, /performReservedRun\(reason, requestId, AUTOMATIC_RUN_OPTIONS\)/);
});

test('agente mantiene ventana, ciclo e idempotencia por casa al refrescar plan', () => {
  const agent = read('ops/whatsapp-runtime/agent/server.js');

  assert.match(agent, /if \(!plan\.allowed\)/);
  assert.match(agent, /if \(!plan\.cycle\)/);
  assert.match(agent, /if \(cs\.completedAt && !forcePlan\)/);
  assert.match(agent, /if \(rec\.confirmedAt\)/);
  assert.match(agent, /ALREADY_CONFIRMED/);
  assert.match(agent, /if \(rec\.dispatchAttemptedAt\)/);
  assert.match(agent, /ALREADY_QUARANTINED/);
  assert.match(agent, /const latestData = await fetchPublicData\(\)/);
  assert.match(agent, /if \(!latestPlan\.allowed \|\| !latestPlan\.cycle \|\| latestPlan\.cycle\.id !== plan\.cycle\.id\)/);
});
