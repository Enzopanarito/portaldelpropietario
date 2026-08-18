'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { TABLES } = require('../netlify/functions/_shared/_backup_inventory');
const { sha256, sortRecords } = require('../netlify/functions/_shared/_integrity');
const oidc = require('../netlify/functions/_shared/_github_oidc_backup');

function sampleBackup() {
  const tables = {};
  const tableHashes = {};
  for (const [index, name] of TABLES.entries()) {
    const records = sortRecords([{ id: `rec${String(index).padStart(3, '0')}`, fields: { sample: index } }]);
    const hash = sha256(records);
    tables[name] = { recordCount: records.length, sha256: hash, records };
    tableHashes[name] = hash;
  }
  const backup = {
    backupType: 'airtable-full-operational-backup',
    schemaVersion: 3,
    generatedAt: '2026-08-18T03:15:00.000Z',
    generatedAtCaracas: '2026-08-17',
    baseId: 'appTESTBACKUP',
    source: 'test',
    tableCount: TABLES.length,
    tables,
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: 'sorted-object-keys-and-record-id',
      tableHashes,
      manifestHash: null
    }
  };
  backup.totalRecords = TABLES.length;
  backup.integrity.manifestHash = sha256({
    backupType: backup.backupType,
    schemaVersion: backup.schemaVersion,
    generatedAt: backup.generatedAt,
    baseId: backup.baseId,
    tableCount: backup.tableCount,
    totalRecords: backup.totalRecords,
    tableHashes: backup.integrity.tableHashes
  });
  backup.integrity.fileContentHash = sha256({ ...backup, integrity: { ...backup.integrity, fileContentHash: null } });
  return backup;
}

test('inventario canónico sigue cubriendo 12 tablas', () => {
  assert.equal(TABLES.length, 12);
  assert.equal(new Set(TABLES).size, 12);
});

test('verificador acepta un backup íntegro 12/12', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-backup-'));
  const file = path.join(dir, 'backup.json');
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(sampleBackup()));
  const run = spawnSync(process.execPath, ['scripts/vla-backup-verify.mjs', file, manifest], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(out.verification.result, 'PASS');
  assert.equal(out.tableCount, 12);
  assert.equal(out.verification.inventory, '12/12');
});

test('verificador rechaza manipulación de un registro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-backup-tamper-'));
  const file = path.join(dir, 'backup.json');
  const backup = sampleBackup();
  backup.tables[TABLES[0]].records[0].fields.sample = 999;
  fs.writeFileSync(file, JSON.stringify(backup));
  const run = spawnSync(process.execPath, ['scripts/vla-backup-verify.mjs', file], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Hash inválido/);
});

test('AES-256-GCM cifra y restaura exactamente el backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-backup-crypto-'));
  const plain = path.join(dir, 'plain.json');
  const encrypted = path.join(dir, 'backup.enc.json');
  const restored = path.join(dir, 'restored.json');
  const original = Buffer.from(JSON.stringify(sampleBackup()));
  fs.writeFileSync(plain, original);
  const env = { ...process.env, VLA_BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
  const enc = spawnSync(process.execPath, ['scripts/vla-backup-crypto.mjs', 'encrypt', plain, encrypted], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(enc.status, 0, enc.stderr);
  const envelope = JSON.parse(fs.readFileSync(encrypted, 'utf8'));
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.doesNotMatch(fs.readFileSync(encrypted, 'utf8'), /Propietarios/);
  const dec = spawnSync(process.execPath, ['scripts/vla-backup-crypto.mjs', 'decrypt', encrypted, restored], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(dec.status, 0, dec.stderr);
  assert.deepEqual(fs.readFileSync(restored), original);
});

test('AES-256-GCM detecta alteración del ciphertext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vla-backup-gcm-'));
  const plain = path.join(dir, 'plain.json');
  const encrypted = path.join(dir, 'backup.enc.json');
  const restored = path.join(dir, 'restored.json');
  fs.writeFileSync(plain, JSON.stringify(sampleBackup()));
  const env = { ...process.env, VLA_BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
  assert.equal(spawnSync(process.execPath, ['scripts/vla-backup-crypto.mjs', 'encrypt', plain, encrypted], { cwd: ROOT, env }).status, 0);
  const envelope = JSON.parse(fs.readFileSync(encrypted, 'utf8'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64');
  bytes[0] ^= 1;
  envelope.ciphertext = bytes.toString('base64');
  fs.writeFileSync(encrypted, JSON.stringify(envelope));
  const dec = spawnSync(process.execPath, ['scripts/vla-backup-crypto.mjs', 'decrypt', encrypted, restored], { cwd: ROOT, env, encoding: 'utf8' });
  assert.notEqual(dec.status, 0);
});

test('OIDC de backup solo acepta workflow, repo, main y evento autorizados', () => {
  const now = 1_787_000_000;
  const valid = {
    iss: oidc.ISSUER,
    aud: oidc.AUDIENCE,
    repository: oidc.REPOSITORY,
    repository_owner: 'Enzopanarito',
    workflow: oidc.WORKFLOW,
    workflow_ref: oidc.WORKFLOW_REF,
    ref: oidc.REF,
    event_name: 'schedule',
    runner_environment: 'github-hosted',
    run_id: '123456789',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300
  };
  assert.equal(oidc.validateClaims(valid, now), valid);
  assert.throws(() => oidc.validateClaims({ ...valid, repository: 'otro/repo' }, now), /OIDC_REPOSITORY_INVALID/);
  assert.throws(() => oidc.validateClaims({ ...valid, workflow: 'Otro Workflow' }, now), /OIDC_WORKFLOW_INVALID/);
  assert.throws(() => oidc.validateClaims({ ...valid, ref: 'refs/heads/feature' }, now), /OIDC_REF_INVALID/);
  assert.throws(() => oidc.validateClaims({ ...valid, event_name: 'pull_request' }, now), /OIDC_EVENT_INVALID/);
});

test('workflow diario cifra, restaura y conserva solo el artefacto cifrado', () => {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows/backup-vla-production.yml'), 'utf8');
  assert.match(source, /cron:\s*'15 7 \* \* \*'/);
  assert.match(source, /VLA_BACKUP_ENCRYPTION_KEY/);
  assert.match(source, /airtable-backup-ci/);
  assert.match(source, /vla-backup-crypto\.mjs encrypt/);
  assert.match(source, /vla-backup-crypto\.mjs decrypt/);
  assert.match(source, /retention-days:\s*90/);
  const artifactBlock = source.split('Upload encrypted external backup')[1] || '';
  assert.match(artifactBlock, /vla-airtable-backup\.enc\.json/);
  assert.doesNotMatch(artifactBlock, /\/tmp\/vla-airtable-backup\.json/);
});
