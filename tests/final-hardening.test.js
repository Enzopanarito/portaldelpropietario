'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const authStore = require('../netlify/functions/_admin_auth_store');
const integrity = require('../netlify/functions/_integrity');
const rate = require('../netlify/functions/_persistent_rate_limit');
const auth = require('../netlify/functions/_auth');

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

// Password migration and compatibility.
const password = 'Vla-Segura-2026!';
const fields = authStore.createPasswordFields(password);
assert.strictEqual(fields.algorithm, 'scrypt-v1');
assert.strictEqual(authStore.verifyPassword(password, fields), true);
assert.strictEqual(authStore.verifyPassword('incorrecta', fields), false);
assert(authStore.validateNewPassword('corta1!'));
assert.strictEqual(authStore.validateNewPassword(password), '');

// Token claims, signature and expiration format.
process.env.ADMIN_TOKEN_SECRET = 'test-secret-that-is-not-a-password-2026';
const token = auth.issueAdminToken({ authVersion: 7 });
const claims = auth.decodeAndVerifyAdminToken(token);
assert(claims && claims.role === 'admin');
assert.strictEqual(claims.iss, 'villa-los-apamates');
assert.strictEqual(claims.aud, 'vla-admin');
assert.strictEqual(claims.authVersion, 7);
assert.strictEqual(auth.verifyAdminToken(token + 'x'), false);

// Deterministic integrity hashes.
assert.strictEqual(integrity.sha256({ b: 2, a: 1 }), integrity.sha256({ a: 1, b: 2 }));
assert.notStrictEqual(integrity.sha256({ a: 1 }), integrity.sha256({ a: 2 }));
const sorted = integrity.sortRecords([{ id: 'recB', fields: { z: 1 } }, { id: 'recA', fields: { z: 1 } }]);
assert.deepStrictEqual(sorted.map(row => row.id), ['recA', 'recB']);

// Rate limit keys never expose raw identity.
const rateKey = rate.keyPrefix('LOGIN', '192.0.2.55', 900000, 1700000000000);
assert(rateKey.startsWith('RATE_EVT|LOGIN|'));
assert(!rateKey.includes('192.0.2.55'));

const netlify = source('netlify.toml');
assert(netlify.includes('Strict-Transport-Security'));
assert(netlify.includes('Content-Security-Policy'));
assert(netlify.includes("object-src 'none'"));
assert(netlify.includes("frame-ancestors 'self'"));
assert(netlify.includes('https://cdn.tailwindcss.com'));
assert(netlify.includes('https://upload.wikimedia.org'));

const proxy = source('netlify/functions/airtable-v2.js');
assert(proxy.includes('GENERIC_WRITE_TABLES'));
assert(proxy.includes("Las escrituras directas en ${target.table} están bloqueadas"));
assert(proxy.includes("'Pagos','Historial de Cargos','Reportes de Pago'"));
assert(proxy.includes('MAX_BODY_BYTES'));

const backup = source('netlify/functions/airtable-backup.js');
assert(backup.includes('schemaVersion: 3'));
assert(backup.includes('manifestHash'));
assert(backup.includes('fileContentHash'));
assert(backup.includes('X-VLA-Backup-Manifest-SHA256'));
assert(fs.existsSync(path.join(__dirname, '..', 'verificar-respaldo.html')));

const bcv = source('netlify/functions/bcv-rate.js');
assert(bcv.includes('loadLastGood'));
assert(bcv.includes('saveLastGood'));
assert(bcv.includes('last-good'));
assert(bcv.includes('FETCH_TIMEOUT_MS'));

const health = source('netlify/functions/system-health-advanced.js');
assert(health.includes('ADMIN_TOKEN_SECRET'));
assert(health.includes('Última tasa BCV persistente'));
assert(health.includes('Operaciones financieras pendientes'));
assert(health.includes('Transparencia pública'));

const ownerEdge = source('netlify/edge-functions/owner-signature.js');
assert(!ownerEdge.includes('new Response(html, response)'));
assert(ownerEdge.includes('x-vla-owner-hardening'));
const adminEdge = source('netlify/edge-functions/admin-monthly-close.js');
assert(adminEdge.includes('system-health-advanced'));
assert(adminEdge.includes('/verificar-respaldo.html'));
assert(adminEdge.includes('x-vla-admin-hardening'));

const securityPage = source('seguridad.html');
assert(securityPage.includes('scrypt'));
assert(securityPage.includes('al menos 12 caracteres'));
assert(securityPage.includes("sessionStorage.setItem('vla-admin-token',d.token)"));

// Parse every inline classic script in HTML files to catch syntax regressions.
for (const filename of fs.readdirSync(path.join(__dirname, '..')).filter(name => name.endsWith('.html'))) {
  const html = source(filename);
  const regex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const code = match[1].trim();
    if (!code) continue;
    try { new vm.Script(code, { filename: `${filename}:inline-script` }); }
    catch (error) { throw new Error(`JavaScript inválido en ${filename}: ${error.message}`); }
  }
}

console.log('FINAL_HARDENING_TESTS_OK');
