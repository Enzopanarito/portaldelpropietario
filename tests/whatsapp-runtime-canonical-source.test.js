'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel));
const sha256 = rel => crypto.createHash('sha256').update(read(rel)).digest('hex');

test('runtime canónico coincide byte-a-byte con el candidato aditivo registrado', () => {
  assert.equal(sha256('ops/whatsapp-runtime/agent/server.js'),
    '1b43b2656195a31d4e6742f9cbb3de71057baf1823d0120bb4423ac1b555785d');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/broadcast.js'),
    '008c74342d2c8d796d88bb7d8dbfae7c29ebcdb2ec996998ae58db73c21b8201');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/message.js'),
    '021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38');
  assert.equal(sha256('ops/whatsapp-runtime/agent/package.json'),
    '85c25a5478dca33a27abf4d4b9844ba370090f9b3eaea0d01e69d98007df2ab8');
  assert.equal(sha256('ops/whatsapp-control/controller.js'),
    '66ff4bf2203fa7d6384e34c6fbd64591d0c697b231db1330a326b774e047297f');
});

test('versiones y fail-closed del runtime canónico', () => {
  const agent = read('ops/whatsapp-runtime/agent/server.js').toString('utf8');
  const controller = read('ops/whatsapp-control/controller.js').toString('utf8');
  assert.match(agent, /version:\s*'1\.4\.0'/);
  assert.match(agent, /DISPATCHED_UNVERIFIED/);
  assert.match(agent, /SENT_CONFIRMED/);
  assert.match(agent, /referenceReconciliationV135:\s*true/);
  assert.match(controller, /version:\s*'1\.4\.0'/);
  assert.match(controller, /failed-closed/);
  assert.match(controller, /interrupted-closed/);
  assert.match(controller, /mode:\s*'paused'/);
  assert.match(controller, /VLA_MANUAL_CYCLE_TRIGGER_V1/);
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
    '215ece473acc52f44c6d7ddfd9c2df35d943db105d16e85e8238ee49d85b0879');
  assert.equal(m.runtime.controller.hotfix, 'VLA_MANUAL_CYCLE_TRIGGER_V1');
  assert.equal(m.runtime.messageLibrary.sha256,
    '021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38');
  assert.equal(m.scheduler.authority, 'controller');
  assert.equal(m.scheduler.legacyNetlifySchedulerEnabled, false);
  assert.equal(m.scheduler.legacyN8nSchedulerExpected, false);
  assert.equal(m.securityAssessment.n8nMasterKeyPubliclyExposed, false);
  assert.equal(m.securityAssessment.futureCapturesRedactEncryptionKeys, true);
  assert.equal(m.activation.automaticAllowed, true);
  assert.deepEqual(m.activation.blockedUntil, []);
  assert.equal(m.communicationsCandidate.status, 'pending-local-installation-and-verification');
  assert.equal(m.communicationsCandidate.doesNotReplaceObservedRuntime, true);
  assert.equal(m.communicationsCandidate.agent.sha256, sha256('ops/whatsapp-runtime/agent/server.js'));
  assert.equal(m.communicationsCandidate.agent.broadcastLibrarySha256, sha256('ops/whatsapp-runtime/agent/lib/broadcast.js'));
  assert.equal(m.communicationsCandidate.controller.sha256, sha256('ops/whatsapp-control/controller.js'));
  assert.equal(m.communicationsCandidate.preserved.financialMessageLibrarySha256, sha256('ops/whatsapp-runtime/agent/lib/message.js'));
  assert.equal(m.communicationsCandidate.preserved.legacyFinancialJobSha256, sha256('netlify/functions/whatsapp-jobs.js'));
  assert.equal(m.communicationsCandidate.preserved.credentialsModified, false);
  assert.equal(m.communicationsCandidate.preserved.schedulerConfigurationModified, false);
  assert.equal(m.communicationsCandidate.preserved.automaticScheduleDefinitionsModified, false);
});
