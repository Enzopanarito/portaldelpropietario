'use strict';

const crypto = require('crypto');

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'vla-close-recovery-production';
const REPOSITORY = 'Enzopanarito/portaldelpropietario';
const REPOSITORY_OWNER = 'Enzopanarito';
const WORKFLOW = 'Recover VLA August Close Certification';
const WORKFLOW_REF = 'Enzopanarito/portaldelpropietario/.github/workflows/recover-vla-august-close-certification.yml@refs/heads/main';
const REF = 'refs/heads/main';
const ALLOWED_EVENTS = new Set(['workflow_run']);
const CLOCK_SKEW_SECONDS = 90;
const CACHE_TTL_MS = 10 * 60 * 1000;

let cachedProvider = null;
let cachedKeys = null;

function parseJsonPart(part) {
  return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
}
function audienceMatches(value) {
  if (Array.isArray(value)) return value.includes(AUDIENCE);
  return String(value || '') === AUDIENCE;
}
function validateClaims(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!claims || claims.iss !== ISSUER) throw new Error('OIDC_ISSUER_INVALID');
  if (!audienceMatches(claims.aud)) throw new Error('OIDC_AUDIENCE_INVALID');
  if (String(claims.repository || '') !== REPOSITORY) throw new Error('OIDC_REPOSITORY_INVALID');
  if (String(claims.repository_owner || '') !== REPOSITORY_OWNER) throw new Error('OIDC_OWNER_INVALID');
  if (String(claims.workflow || '') !== WORKFLOW) throw new Error('OIDC_WORKFLOW_INVALID');
  if (String(claims.workflow_ref || '') !== WORKFLOW_REF) throw new Error('OIDC_WORKFLOW_REF_INVALID');
  if (String(claims.ref || '') !== REF) throw new Error('OIDC_REF_INVALID');
  if (!ALLOWED_EVENTS.has(String(claims.event_name || ''))) throw new Error('OIDC_EVENT_INVALID');
  if (String(claims.runner_environment || '') !== 'github-hosted') throw new Error('OIDC_RUNNER_INVALID');
  const exp = Number(claims.exp || 0), nbf = Number(claims.nbf || 0), iat = Number(claims.iat || 0);
  if (!Number.isFinite(exp) || exp <= nowSeconds - CLOCK_SKEW_SECONDS) throw new Error('OIDC_EXPIRED');
  if (Number.isFinite(nbf) && nbf > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error('OIDC_NOT_YET_VALID');
  if (!Number.isFinite(iat) || iat > nowSeconds + CLOCK_SKEW_SECONDS || iat < nowSeconds - 15 * 60) throw new Error('OIDC_IAT_INVALID');
  if (!/^\d+$/.test(String(claims.run_id || ''))) throw new Error('OIDC_RUN_ID_INVALID');
  return claims;
}
async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'VLA-Close-Recovery-CI' } });
  if (!response.ok) throw new Error(`OIDC_HTTP_${response.status}`);
  return response.json();
}
async function provider(fetchImpl) {
  if (cachedProvider && cachedProvider.expiresAt > Date.now()) return cachedProvider.value;
  const value = await fetchJson(`${ISSUER}/.well-known/openid-configuration`, fetchImpl);
  if (value.issuer !== ISSUER || !String(value.jwks_uri || '').startsWith(`${ISSUER}/`)) throw new Error('OIDC_PROVIDER_INVALID');
  cachedProvider = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
async function keys(jwksUri, fetchImpl) {
  if (cachedKeys && cachedKeys.uri === jwksUri && cachedKeys.expiresAt > Date.now()) return cachedKeys.value;
  const value = await fetchJson(jwksUri, fetchImpl);
  if (!Array.isArray(value.keys)) throw new Error('OIDC_JWKS_INVALID');
  cachedKeys = { uri: jwksUri, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}
async function verifyCloseRecoveryOidcToken(token, options = {}) {
  const value = String(token || '');
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('OIDC_TOKEN_INVALID');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJsonPart(encodedHeader);
  const claims = parseJsonPart(encodedPayload);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('OIDC_HEADER_INVALID');
  const fetchImpl = options.fetchImpl || fetch;
  const configuration = await provider(fetchImpl);
  const jwks = await keys(configuration.jwks_uri, fetchImpl);
  const jwk = jwks.keys.find(item => item && item.kid === header.kid && item.kty === 'RSA' && (!item.alg || item.alg === 'RS256'));
  if (!jwk) throw new Error('OIDC_KEY_NOT_FOUND');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verified = crypto.verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(encodedSignature, 'base64url'));
  if (!verified) throw new Error('OIDC_SIGNATURE_INVALID');
  return validateClaims(claims, options.nowSeconds);
}
function resetCachesForTests() { cachedProvider = null; cachedKeys = null; }

module.exports = {
  ISSUER,
  AUDIENCE,
  REPOSITORY,
  WORKFLOW,
  WORKFLOW_REF,
  REF,
  ALLOWED_EVENTS,
  validateClaims,
  verifyCloseRecoveryOidcToken,
  resetCachesForTests
};
