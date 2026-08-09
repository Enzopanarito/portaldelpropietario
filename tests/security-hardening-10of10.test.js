'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('../netlify/functions/_shared/_auth');
const health = require('../netlify/functions/system-health-advanced');
const backup = require('../netlify/functions/airtable-backup');
const inventory = require('../netlify/functions/_shared/_backup_inventory');

const STRONG_A = 'a'.repeat(64);
const STRONG_B = 'b'.repeat(64);

function productionEnv(extra = {}) {
  return {
    CONTEXT: 'production',
    VLA_DATA_ENVIRONMENT: 'production',
    ADMIN_TOKEN_SECRET: STRONG_A,
    AIRTABLE_API_TOKEN: STRONG_B,
    PAYMENT_PROOF_ENCRYPTION_KEY: 'c'.repeat(64),
    ADMIN_PASSWORD: 'd'.repeat(64),
    ...extra
  };
}

test('producción falla cerrada sin ADMIN_SESSION_SIGNING_KEY dedicada', () => {
  const info = auth.getSecretInfo(productionEnv());
  assert.equal(info.secret, '');
  assert.equal(info.source, 'missing');
  assert.equal(info.dedicated, false);
  assert.equal(info.productionSafe, false);
  assert.equal(info.errorCode, 'ADMIN_SESSION_SIGNING_KEY_REQUIRED');
});

test('producción usa exclusivamente ADMIN_SESSION_SIGNING_KEY dedicada sin cambiar el formato del token', () => {
  const root = 'session-root-'.repeat(8);
  const info = auth.getSecretInfo(productionEnv({ ADMIN_SESSION_SIGNING_KEY: root }));
  assert.equal(info.source, 'ADMIN_SESSION_SIGNING_KEY');
  assert.equal(info.dedicated, true);
  assert.equal(info.productionSafe, true);
  assert.equal(info.keyVersion, 2);
  assert.notEqual(info.secret, root);
  assert.equal(info.secret, auth.deriveSessionSecret(root));
});

test('cambiar secretos ajenos no cambia la firma cuando existe raíz dedicada', () => {
  const root = 'isolated-session-key-'.repeat(4);
  const first = auth.getSecretInfo(productionEnv({
    ADMIN_SESSION_SIGNING_KEY: root,
    AIRTABLE_API_TOKEN: 'x'.repeat(64),
    PAYMENT_PROOF_ENCRYPTION_KEY: 'y'.repeat(64)
  }));
  const second = auth.getSecretInfo(productionEnv({
    ADMIN_SESSION_SIGNING_KEY: root,
    AIRTABLE_API_TOKEN: 'm'.repeat(64),
    PAYMENT_PROOF_ENCRYPTION_KEY: 'n'.repeat(64)
  }));
  assert.equal(first.secret, second.secret);
});

test('previews y tests conservan fallback solo fuera de producción', () => {
  const info = auth.getSecretInfo({
    CONTEXT: 'deploy-preview',
    VLA_DATA_ENVIRONMENT: 'staging',
    ADMIN_TOKEN_SECRET: STRONG_A
  });
  assert.equal(info.source, 'ADMIN_TOKEN_SECRET');
  assert.equal(info.secret, STRONG_A);
  assert.equal(info.dedicated, false);
  assert.equal(info.productionSafe, false);
});

test('la sesión CI de solo lectura sigue bloqueando escrituras', () => {
  assert.equal(auth.ciReadOnlyAllowed({
    httpMethod: 'GET',
    path: '/.netlify/functions/system-health'
  }), true);
  assert.equal(auth.ciReadOnlyAllowed({
    httpMethod: 'POST',
    path: '/.netlify/functions/monthly-close',
    body: JSON.stringify({ dryRun: true })
  }), true);
  assert.equal(auth.ciReadOnlyAllowed({
    httpMethod: 'POST',
    path: '/.netlify/functions/monthly-close',
    body: JSON.stringify({ dryRun: false, confirmed: true })
  }), false);
  assert.equal(auth.ciReadOnlyAllowed({
    httpMethod: 'POST',
    path: '/.netlify/functions/admin-manual-payment',
    body: '{}'
  }), false);
});

test('Health informa la fuente real de la firma sin exponer la clave', () => {
  const root = 'health-session-root-'.repeat(4);
  const result = health.adminSessionKeyHealth(productionEnv({ ADMIN_SESSION_SIGNING_KEY: root }));
  assert.equal(result.ok, true);
  assert.equal(result.severity, 'ok');
  assert.equal(result.meta.source, 'ADMIN_SESSION_SIGNING_KEY');
  assert.equal(result.meta.dedicated, true);
  assert.equal(Object.hasOwn(result.meta, 'secret'), false);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('Health marca como error la firma administrativa sin raíz dedicada', () => {
  const result = health.adminSessionKeyHealth(productionEnv());
  assert.equal(result.ok, false);
  assert.equal(result.severity, 'error');
  assert.equal(result.meta.source, 'missing');
});

test('Health exige PAYMENT_PROOF_ENCRYPTION_KEY dedicada', () => {
  const result = health.paymentProofKeyHealth(productionEnv());
  assert.equal(result.ok, true);
  assert.equal(result.severity, 'ok');
  assert.equal(result.meta.source, 'PAYMENT_PROOF_ENCRYPTION_KEY');
  assert.equal(result.meta.dedicated, true);
  assert.equal(Object.hasOwn(result.meta, 'key'), false);
});

test('el respaldo operativo usa el mismo inventario canónico que Health', () => {
  assert.equal(backup.TABLES, inventory.TABLES);
  assert.equal(inventory.TABLES.length, 12);
  assert.equal(new Set(inventory.TABLES).size, 12);
  assert.equal(inventory.TABLES.includes('Cuentas de Cobro Autorizadas'), true);
  const healthSource = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'system-health-advanced.js'), 'utf8');
  assert.match(healthSource, /BACKUP_TABLES\.length/);
  assert.doesNotMatch(healthSource, /EXPECTED_BACKUP_TABLES\s*=\s*\d+/);
});

test('2FA deshabilitado se registra como riesgo aceptado, no como falso verde', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'system-health-advanced.js'), 'utf8');
  assert.match(source, /Autenticación de dos pasos'[\s\S]*'info'[\s\S]*acceptedRisk:true/);
  assert.doesNotMatch(source, /Autenticación de dos pasos',\s*true/);
});

test('el modo skip-netlify bloquea el workflow CLI de preview', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'netlify-cli-preview.yml'), 'utf8');
  assert.match(source, /!contains\(github\.event\.pull_request\.title, '\[skip netlify\]'\)/);
});

test('el baseline financiero se liga al commit base y release reales, sin SHA hardcodeado', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'capture-final-financial-baseline.yml'), 'utf8');
  assert.match(source, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(source, /sourceRelease:release\.release/);
  assert.doesNotMatch(source, /sourceCommit:'[a-f0-9]{40}'/);
});
