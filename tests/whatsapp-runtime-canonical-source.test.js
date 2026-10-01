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
    '79a9eeaef011710d81999ff912e1cd8a7aa59f16ef9c9c87d4a0a1cebd7583fe');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/broadcast.js'),
    '008c74342d2c8d796d88bb7d8dbfae7c29ebcdb2ec996998ae58db73c21b8201');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/message.js'),
    '15aca2bce33e63eb4a38340bd9d162cc59192cb592063dfaded9d838ec4e0465');
  assert.equal(sha256('ops/whatsapp-runtime/agent/package.json'),
    '85c25a5478dca33a27abf4d4b9844ba370090f9b3eaea0d01e69d98007df2ab8');
  assert.equal(sha256('ops/whatsapp-control/controller.js'),
    'fd263ada5e72e90fd8458c48a7750a9df3b7fd66a091627afc9d3713fbbdf203');
});

test('versiones y fail-closed del runtime canónico', () => {
  const agent = read('ops/whatsapp-runtime/agent/server.js').toString('utf8');
  const controller = read('ops/whatsapp-control/controller.js').toString('utf8');
  assert.match(agent, /version:\s*'1\.4\.2'/);
  assert.match(agent, /DISPATCHED_UNVERIFIED/);
  assert.match(agent, /SENT_CONFIRMED/);
  assert.match(agent, /referenceReconciliationV135:\s*true/);
  assert.match(agent, /financialRevisionV136:\s*true/);
  assert.match(agent, /VLA_SESSION_READINESS_V137/);
  assert.match(agent, /financialRevision:\s*req\.body\?\.financialRevision === true/);
  assert.match(agent, /expenseFingerprint/);
  assert.match(agent, /recoverablePreDispatchCount/);
  assert.match(agent, /monthlyGateRestrictionNoticeV1:\s*true/);
  assert.match(agent, /VLA_MONTHLY_GATE_RESTRICTION_NOTICE_V1/);
  assert.match(agent, /VLA-\$\{parts\.year\}\$\{parts\.month\}\$\{parts\.day\}0800-C/);
  assert.match(controller, /version:\s*'1\.4\.3'/);
  assert.match(controller, /VLA_REAL_READINESS_HEALTH_V2/);
  assert.match(controller, /isIncompleteRecoverableRun/);
  assert.match(controller, /manualFinancialRevision = reason === 'admin-manual'/);
  assert.match(controller, /failed-closed/);
  assert.match(controller, /interrupted-closed/);
  assert.match(controller, /mode:\s*'paused'/);
  assert.match(controller, /VLA_MANUAL_CYCLE_TRIGGER_V1/);
  assert.match(controller, /run\|daily/);
  assert.match(controller, /dailyRunKey/);
  assert.match(controller, /GATE_NOTICE_TIME\s*=\s*'08:00'/);
  assert.match(controller, /GATE_NOTICE_WARMUP_TIME\s*=\s*'07:55'/);
  assert.match(controller, /gate-restriction/);
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
  assert.equal(m.runtime.agent.observedVersion, '1.4.2');
  assert.equal(m.runtime.controller.observedVersion, '1.4.3');
  assert.equal(m.runtime.agent.sha256,
    '79a9eeaef011710d81999ff912e1cd8a7aa59f16ef9c9c87d4a0a1cebd7583fe');
  assert.equal(m.runtime.controller.sha256,
    'fd263ada5e72e90fd8458c48a7750a9df3b7fd66a091627afc9d3713fbbdf203');
  assert.equal(m.runtime.controller.hotfix, 'VLA_MONTHLY_GATE_RESTRICTION_NOTICE_V1');
  assert.equal(m.runtime.messageLibrary.sha256,
    '15aca2bce33e63eb4a38340bd9d162cc59192cb592063dfaded9d838ec4e0465');
  assert.equal(m.scheduler.authority, 'controller');
  assert.equal(m.scheduler.legacyNetlifySchedulerEnabled, false);
  assert.equal(m.scheduler.legacyN8nSchedulerExpected, false);
  assert.equal(m.securityAssessment.n8nMasterKeyPubliclyExposed, false);
  assert.equal(m.securityAssessment.futureCapturesRedactEncryptionKeys, true);
  assert.equal(m.activation.automaticAllowed, true);
  assert.deepEqual(m.activation.blockedUntil, []);
  assert.equal(m.communicationsCandidate.status, 'installed-and-verified-live');
  assert.equal(m.communicationsCandidate.doesNotReplaceObservedRuntime, false);
  assert.equal(m.communicationsCandidate.agent.sha256, sha256('ops/whatsapp-runtime/agent/server.js'));
  assert.equal(m.communicationsCandidate.agent.broadcastLibrarySha256, sha256('ops/whatsapp-runtime/agent/lib/broadcast.js'));
  assert.equal(m.communicationsCandidate.controller.sha256, sha256('ops/whatsapp-control/controller.js'));
  assert.equal(m.communicationsCandidate.preserved.financialMessageLibrarySha256, sha256('ops/whatsapp-runtime/agent/lib/message.js'));
  assert.equal(m.communicationsCandidate.preserved.legacyFinancialJobSha256, sha256('netlify/functions/whatsapp-jobs.js'));
  assert.equal(m.communicationsCandidate.preserved.credentialsModified, false);
  assert.equal(m.communicationsCandidate.preserved.schedulerConfigurationModified, false);
  assert.equal(m.communicationsCandidate.preserved.automaticScheduleDefinitionsModified, true);
  assert.deepEqual(m.scheduler.expectedSchedules, ['09:00']);
  assert.equal(m.scheduler.singleDailyRun, true);
  assert.equal(m.scheduler.monthlyGateRestrictionNotice.time, '08:00');
  assert.equal(m.scheduler.monthlyGateRestrictionNotice.normalReminderStillRunsAt, '09:00');
  assert.equal(m.runtime.scheduleLibrary.sha256, sha256('ops/whatsapp-runtime/agent/lib/schedule.js'));
});
