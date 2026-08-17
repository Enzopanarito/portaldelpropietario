'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('exactly_one_effective_whatsapp_scheduler: Controller es la única autoridad', () => {
  const controller = read('ops/whatsapp-control/controller.js');
  const legacy = read('netlify/functions/whatsapp-jobs.js');
  const gateway = JSON.parse(read('ops/whatsapp-control/n8n/VLA_WhatsApp_Admin_Gateway_v1.template.json'));

  // El Controller conserva el único loop de planificación efectivo.
  assert.match(controller, /schedulerStep/);
  assert.match(controller, /setInterval\(\(\) => state\.schedulerStep\(\)/);

  // El backend histórico no puede crear ni ejecutar programaciones por HTTP.
  assert.match(legacy, /LEGACY_WHATSAPP_JOBS_DISABLED/);
  assert.match(legacy, /schedulerAuthority:\s*'controller'/);
  assert.match(legacy, /action === 'createSchedule' \|\| action === 'runScheduler'/);
  assert.match(legacy, /resource === 'scheduler-run'/);
  assert.doesNotMatch(legacy, /resource === 'scheduler-run'\) return json\(200, await runScheduler\(\)\)/);
  assert.doesNotMatch(legacy, /if \(body\.action === 'runScheduler'\) return json\(200, await runScheduler\(\)\)/);

  // El gateway n8n es transporte, no scheduler.
  const nodeTypes = gateway.nodes.map(node => node.type);
  assert.equal(nodeTypes.some(type => /scheduleTrigger|cron/i.test(type)), false);
  assert.equal(gateway.active, false, 'La plantilla versionada debe nacer inactiva');
  const http = gateway.nodes.find(node => node.type === 'n8n-nodes-base.httpRequest');
  assert.ok(http, 'Falta el relay HTTP hacia Controller');
  assert.equal(http.parameters.url, 'http://whatsapp-controller:8788/control');
});

test('legacy whatsapp-jobs es fail-closed para mutaciones en operación normal', () => {
  const legacy = read('netlify/functions/whatsapp-jobs.js');
  assert.match(legacy, /VLA_ENABLE_LEGACY_WHATSAPP_JOBS/);
  assert.match(legacy, /if \(!LEGACY_MUTATIONS_ENABLED\)/);
  assert.match(legacy, /return legacyDisabled/);

  // GET nunca puede convertirse en una mutación encubierta.
  const getBlockStart = legacy.indexOf("if (event.httpMethod === 'GET')");
  const postBlockStart = legacy.indexOf("if (event.httpMethod !== 'POST')", getBlockStart);
  assert.ok(getBlockStart >= 0 && postBlockStart > getBlockStart);
  const getBlock = legacy.slice(getBlockStart, postBlockStart);
  assert.doesNotMatch(getBlock, /await createJob\(/);
  assert.doesNotMatch(getBlock, /await updateJobByJobId\(/);
  assert.doesNotMatch(getBlock, /await runScheduler\(/);
});

test('runtime local no se declara certificado sin hash exacto', () => {
  const manifest = JSON.parse(read('ops/whatsapp-control/runtime-release.json'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.certification.status, 'awaiting-local-capture');
  assert.equal(manifest.scheduler.authority, 'controller');
  assert.equal(manifest.scheduler.legacyNetlifySchedulerEnabled, false);
  assert.equal(manifest.activation.automaticAllowed, false);
  assert.equal(manifest.runtime.agent.sha256, null);
  assert.equal(manifest.runtime.controller.sha256, null);
});

test('captura local es solo lectura, sintácticamente válida y prohíbe acciones de WhatsApp', () => {
  const rel = 'ops/whatsapp-control/AUDITAR_RUNTIME_LOCAL_SOLO_LECTURA.command';
  const scriptPath = path.join(ROOT, rel);
  const script = read(rel);
  assert.match(script, /SOLO LECTURA/);
  assert.match(script, /controller.*paused/i);
  assert.match(script, /state_sha_before/);
  assert.match(script, /state_sha_after/);
  assert.match(script, /control_sha_before/);
  assert.match(script, /control_sha_after/);
  assert.match(script, /runtime_sha_before/);
  assert.match(script, /runtime_sha_after/);
  assert.doesNotMatch(script, /-d\s+['\"]\{[^\n]*(tick|warmup|resume|link-start|run-now)/i);
  assert.doesNotMatch(script, /\/tick\b/);
  assert.doesNotMatch(script, /\/session\/warmup\b/);
  assert.doesNotMatch(script, /\/session\/link\//);

  const checked = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});
