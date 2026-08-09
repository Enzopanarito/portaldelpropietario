'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const original = {
  ADMIN_SESSION_SIGNING_KEY: process.env.ADMIN_SESSION_SIGNING_KEY,
  PAYMENT_PROOF_ENCRYPTION_KEY: process.env.PAYMENT_PROOF_ENCRYPTION_KEY,
  ADMIN_TOKEN_SECRET: process.env.ADMIN_TOKEN_SECRET,
  AIRTABLE_API_TOKEN: process.env.AIRTABLE_API_TOKEN,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD
};
delete process.env.ADMIN_SESSION_SIGNING_KEY;
delete process.env.PAYMENT_PROOF_ENCRYPTION_KEY;
delete process.env.AIRTABLE_API_TOKEN;
delete process.env.ADMIN_PASSWORD;
process.env.ADMIN_TOKEN_SECRET = 'a'.repeat(64);

const auth = require('../netlify/functions/_shared/_auth');

function event(path, method = 'GET', body = '') {
  return { path, httpMethod: method, body, headers: {} };
}
function withToken(base, token) {
  return { ...base, headers: { authorization: `Bearer ${token}` } };
}

test('la sesión CI queda marcada como solo lectura y no pasa verifyAdminToken', () => {
  const token = auth.issueAdminToken({ role: 'admin-ci-readonly', ciRunId: '12345' });
  const claims = auth.decodeAndVerifyAdminToken(token);
  assert.equal(claims.role, 'admin-ci-readonly');
  assert.equal(claims.ciRunId, '12345');
  assert.equal(auth.verifyAdminToken(token), false);
});

test('la sesión CI permite solo endpoints de lectura explícitos', () => {
  const token = auth.issueAdminToken({ role: 'admin-ci-readonly', ciRunId: '12345' });
  assert.equal(auth.requireAdmin(withToken(event('/.netlify/functions/admin-data'), token)).ok, true);
  assert.equal(auth.requireAdmin(withToken(event('/.netlify/functions/system-health-advanced'), token)).ok, true);
  assert.equal(auth.requireAdmin(withToken(event('/.netlify/functions/access-reconciliation-readonly'), token)).ok, true);
  const backup = auth.requireAdmin(withToken(event('/.netlify/functions/airtable-backup'), token));
  assert.equal(backup.ok, false);
  assert.equal(backup.response.statusCode, 403);
});

test('la sesión CI solo permite monthly-close en DRY RUN', () => {
  const token = auth.issueAdminToken({ role: 'admin-ci-readonly', ciRunId: '12345' });
  assert.equal(auth.requireAdmin(withToken(event('/.netlify/functions/monthly-close', 'POST', JSON.stringify({ dryRun: true })), token)).ok, true);
  const realClose = auth.requireAdmin(withToken(event('/.netlify/functions/monthly-close', 'POST', JSON.stringify({ confirmed: true })), token));
  assert.equal(realClose.ok, false);
  assert.equal(realClose.response.statusCode, 403);
  const write = auth.requireAdmin(withToken(event('/.netlify/functions/admin-manual-payment', 'POST', '{}'), token));
  assert.equal(write.ok, false);
  assert.equal(write.response.statusCode, 403);
});

test('la sesión humana admin conserva permisos normales', () => {
  const token = auth.issueAdminToken({ authVersion: 4 });
  assert.equal(auth.verifyAdminToken(token), true);
  assert.equal(auth.requireAdmin(withToken(event('/.netlify/functions/admin-manual-payment', 'POST', '{}'), token)).ok, true);
});

test.after(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
