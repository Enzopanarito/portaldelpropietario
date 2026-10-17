import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMasterKeyBase64, openSecret, sealSecret } from '../lib/server/secret-envelope.js';
import { buildPublicTenantBootstrap, normalizeHostname, resolveTenantBootstrap } from '../lib/server/tenant-bootstrap.js';

test('AES-256-GCM secret envelope round-trips and is tenant-bound', () => {
  const key = generateMasterKeyBase64();
  const envelope = sealSecret({ plaintext: 'refresh-token-secret', tenantId: 'tenant-a', purpose: 'supabase-management-oauth', keyVersion: 'k1', masterKeyBase64: key });
  assert.equal(openSecret({ envelope, tenantId: 'tenant-a', purpose: 'supabase-management-oauth', masterKeyBase64: key }), 'refresh-token-secret');
  assert.throws(() => openSecret({ envelope, tenantId: 'tenant-b', purpose: 'supabase-management-oauth', masterKeyBase64: key }), error => error.code === 'SECRET_CONTEXT_MISMATCH');
});

test('tampering with ciphertext is rejected', () => {
  const key = generateMasterKeyBase64();
  const envelope = sealSecret({ plaintext: 'db-password', tenantId: 'tenant-a', purpose: 'database-password', keyVersion: 'k1', masterKeyBase64: key });
  const bytes = Buffer.from(envelope.ciphertextB64, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => openSecret({ envelope: { ...envelope, ciphertextB64: bytes.toString('base64') }, tenantId: 'tenant-a', purpose: 'database-password', masterKeyBase64: key }), error => error.code === 'SECRET_AUTH_FAILED');
});

test('tenant bootstrap exposes only browser-safe Data Plane fields', () => {
  const bootstrap = buildPublicTenantBootstrap({
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantSlug: 'residencias-a', displayName: 'Residencias A', countryCode: 've', countryPackVersion: 'VE-0.1',
    projectUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_example',
    capabilities: ['payments','access','evil','payments'], secretKey: 'sb_secret_must_not_leak', databasePassword: 'never'
  });
  assert.deepEqual(bootstrap.capabilities, ['access','payments']);
  assert.equal(bootstrap.supabaseUrl, 'https://abcdefghijklmnopqrst.supabase.co');
  assert.equal('secretKey' in bootstrap, false);
  assert.equal('databasePassword' in bootstrap, false);
});

test('hostname resolver normalizes case/port and fails closed for unverified tenant', async () => {
  assert.equal(normalizeHostname('Portal.Example.COM:443'), 'portal.example.com');
  const ok = await resolveTenantBootstrap({
    host: 'Portal.Example.COM:443',
    lookupByHostname: async hostname => ({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', tenantSlug: 'residencias-a', displayName: 'Residencias A', countryCode: 'VE', countryPackVersion: 'VE-0.1',
      projectUrl: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_example', capabilities: ['payments'],
      status: 'active', domainStatus: hostname === 'portal.example.com' ? 'verified' : 'pending'
    })
  });
  assert.equal(ok.tenantSlug, 'residencias-a');
  await assert.rejects(() => resolveTenantBootstrap({
    host: 'pending.example.com',
    lookupByHostname: async () => ({ status: 'active', domainStatus: 'pending' })
  }), error => error.code === 'TENANT_NOT_AVAILABLE');
});

test('malformed Data Plane credentials fail before bootstrap', () => {
  assert.throws(() => buildPublicTenantBootstrap({ tenantSlug: 'ok-slug', projectUrl: 'http://bad.example.com', publishableKey: 'sb_publishable_x' }), error => error.code === 'DATA_PLANE_URL_INVALID');
  assert.throws(() => buildPublicTenantBootstrap({ tenantSlug: 'ok-slug', projectUrl: 'https://ok.example.com', publishableKey: 'legacy-anon-key' }), error => error.code === 'DATA_PLANE_PUBLISHABLE_KEY_INVALID');
});
