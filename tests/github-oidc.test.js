'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const oidc = require('../netlify/functions/_shared/_github_oidc');

const now = 1786267000;
function claims(overrides = {}) {
  return {
    iss: oidc.ISSUER,
    aud: oidc.AUDIENCE,
    sub: 'repo:Enzopanarito/portaldelpropietario:ref:refs/heads/main',
    repository: 'Enzopanarito/portaldelpropietario',
    repository_owner: 'Enzopanarito',
    workflow: 'Verify Admin Production',
    workflow_ref: oidc.WORKFLOW_REF,
    ref: 'refs/heads/main',
    event_name: 'workflow_run',
    runner_environment: 'github-hosted',
    run_id: '31304468028',
    iat: now - 30,
    nbf: now - 30,
    exp: now + 300,
    ...overrides
  };
}
function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function signedToken(privateKey, payload, kid = 'vla-test-key') {
  const header = encode({ alg: 'RS256', typ: 'JWT', kid });
  const body = encode(payload);
  const input = `${header}.${body}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}
function mockFetch(jwk) {
  return async url => {
    if (String(url).endsWith('/.well-known/openid-configuration')) return { ok: true, json: async () => ({ issuer: oidc.ISSUER, jwks_uri: `${oidc.ISSUER}/.well-known/jwks` }) };
    if (String(url).endsWith('/.well-known/jwks')) return { ok: true, json: async () => ({ keys: [jwk] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('acepta únicamente un JWT RS256 válido del workflow de producción', async () => {
  oidc.resetCachesForTests();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'vla-test-key', alg: 'RS256', use: 'sig' });
  const result = await oidc.verifyGitHubOidcToken(signedToken(privateKey, claims()), { fetchImpl: mockFetch(jwk), nowSeconds: now });
  assert.equal(result.repository, 'Enzopanarito/portaldelpropietario');
  assert.equal(result.workflow_ref, oidc.WORKFLOW_REF);
});

test('rechaza audiencia, rama, workflow o repositorio distintos', () => {
  for (const bad of [
    { aud: 'otra-audiencia' },
    { ref: 'refs/heads/feature' },
    { workflow: 'Otro Workflow' },
    { workflow_ref: 'Enzopanarito/portaldelpropietario/.github/workflows/otro.yml@refs/heads/main' },
    { repository: 'otro/repo' },
    { runner_environment: 'self-hosted' }
  ]) assert.throws(() => oidc.validateClaims(claims(bad), now));
});

test('rechaza firma inválida aunque las claims parezcan correctas', async () => {
  oidc.resetCachesForTests();
  const trusted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = trusted.publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'vla-test-key', alg: 'RS256', use: 'sig' });
  await assert.rejects(() => oidc.verifyGitHubOidcToken(signedToken(attacker.privateKey, claims()), { fetchImpl: mockFetch(jwk), nowSeconds: now }), /OIDC_SIGNATURE_INVALID/);
});
