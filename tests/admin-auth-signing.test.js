'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../netlify/functions/_shared/_auth');

const ENV_KEYS = [
  'ADMIN_SESSION_SIGNING_KEY',
  'PAYMENT_PROOF_ENCRYPTION_KEY',
  'ADMIN_TOKEN_SECRET',
  'AIRTABLE_API_TOKEN',
  'ADMIN_PASSWORD'
];

function withEnvironment(values, callback) {
  const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return callback();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test('firma y valida una sesión usando una clave fuerte disponible del servidor', () => {
  withEnvironment({ AIRTABLE_API_TOKEN: 'pat_test_only_1234567890abcdefghijklmnopqrstuvwxyz' }, () => {
    const secret = auth.getSecret();
    assert.equal(secret.length, 64);
    assert.notEqual(secret, process.env.AIRTABLE_API_TOKEN);

    const token = auth.issueAdminToken({ authVersion: 7 });
    const claims = auth.decodeAndVerifyAdminToken(token);

    assert.equal(claims.role, 'admin');
    assert.equal(claims.authVersion, 7);
    assert.equal(claims.keyVersion, 2);
    assert.equal(auth.verifyAdminToken(token), true);
  });
});

test('rechaza firmar sesiones cuando no existe ninguna clave fuerte', () => {
  withEnvironment({ ADMIN_PASSWORD: 'corta' }, () => {
    assert.throws(
      () => auth.issueAdminToken(),
      (error) => error && error.code === 'ADMIN_SIGNING_KEY_WEAK'
    );
  });
});
