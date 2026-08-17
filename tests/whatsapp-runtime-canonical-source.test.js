'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel));
const sha256 = rel => crypto.createHash('sha256').update(read(rel)).digest('hex');

test('runtime canónico coincide byte-a-byte con la captura certificada', () => {
  assert.equal(sha256('ops/whatsapp-runtime/agent/server.js'),
    'a4705ff28b52337597b8bf42ac15949acedc74798f62360f284fa758fdf3eee4');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/message.js'),
    '021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38');
  assert.equal(sha256('ops/whatsapp-runtime/agent/package.json'),
    '85c25a5478dca33a27abf4d4b9844ba370090f9b3eaea0d01e69d98007df2ab8');
  assert.equal(sha256('ops/whatsapp-control/controller.js'),
    'b79e29f126d15f9d0a590d49bc9be48ac1b52715c59e9b8b7f3bbed89aacff67');
});

test('versiones y fail-closed del runtime canónico', () => {
  const agent = read('ops/whatsapp-runtime/agent/server.js').toString('utf8');
  const controller = read('ops/whatsapp-control/controller.js').toString('utf8');
  assert.match(agent, /version:\s*'1\.3\.5'/);
  assert.match(agent, /DISPATCHED_UNVERIFIED/);
  assert.match(agent, /SENT_CONFIRMED/);
  assert.match(agent, /referenceReconciliationV135:\s*true/);
  assert.match(controller, /version:\s*'1\.3\.4'/);
  assert.match(controller, /failed-closed/);
  assert.match(controller, /interrupted-closed/);
  assert.match(controller, /mode:\s*'paused'/);
  assert.match(controller, /setInterval\(\(\) => state\.schedulerStep\(\)/);
});

test('auditor redacta también claves de cifrado', () => {
  const audit = read('ops/whatsapp-control/AUDITAR_RUNTIME_LOCAL_SOLO_LECTURA.command').toString('utf8');
  assert.match(audit, /ENCRYPTION/);
  assert.match(audit, /sensitive=re\.compile/);
});

test('manifiesto fija hashes y habilita activation solo después de certificación', () => {
  const m = JSON.parse(read('ops/whatsapp-control/runtime-release.json').toString('utf8'));
  assert.equal(m.certification.status, 'release-ready-automatic');
  assert.equal(m.certification.financialDeltaUsd, '0.00');
  assert.equal(m.runtime.agent.observedVersion, '1.3.5');
  assert.equal(m.runtime.controller.observedVersion, '1.3.4');
  assert.equal(m.runtime.agent.sha256,
    'a4705ff28b52337597b8bf42ac15949acedc74798f62360f284fa758fdf3eee4');
  assert.equal(m.runtime.controller.sha256,
    'b79e29f126d15f9d0a590d49bc9be48ac1b52715c59e9b8b7f3bbed89aacff67');
  assert.equal(m.runtime.messageLibrary.sha256,
    '021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38');
  assert.equal(m.scheduler.authority, 'controller');
  assert.equal(m.scheduler.legacyNetlifySchedulerEnabled, false);
  assert.equal(m.scheduler.legacyN8nSchedulerExpected, false);
  assert.equal(m.securityAssessment.n8nMasterKeyPubliclyExposed, false);
  assert.equal(m.securityAssessment.futureCapturesRedactEncryptionKeys, true);
  assert.equal(m.activation.automaticAllowed, true);
  assert.deepEqual(m.activation.blockedUntil, []);
});
