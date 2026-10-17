'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { AccessProvider } = require('../platform/core/access-provider');
const { loadCountryPack, loadCountryPackObject } = require('../platform/core/country-pack');
const { readRuntimeConfig, publicRuntimeConfig } = require('../platform/core/runtime-config');
const { MkjAccessProvider } = require('../platform/providers/mkj-access-provider');

const vePackPath = path.join(__dirname, '..', 'config', 'country-packs', 've.json');

test('VE Country Pack loads with regional safety invariants', () => {
  const pack = loadCountryPack(vePackPath);
  assert.equal(pack.countryCode, 'VE');
  assert.equal(pack.currency.primary, 'VES');
  assert.equal(pack.currency.allowed.includes('USD'), true);
  assert.equal(pack.access.storeBiometricTemplatesInCore, false);
  assert.equal(pack.collections.physicalAccessRestrictionByDebt, 'legal-review-required');
  assert.equal(Object.isFrozen(pack), true);
});

test('Country Pack rejects raw biometric storage in the core', () => {
  const pack = JSON.parse(require('node:fs').readFileSync(vePackPath, 'utf8'));
  pack.access.storeBiometricTemplatesInCore = true;
  assert.throws(() => loadCountryPackObject(pack), /must not store raw biometric templates/);
});

test('Country Pack rejects a primary currency not listed as allowed', () => {
  const pack = JSON.parse(require('node:fs').readFileSync(vePackPath, 'utf8'));
  pack.currency.primary = 'COP';
  assert.throws(() => loadCountryPackObject(pack), /must include currency.primary/);
});

test('runtime config separates public Supabase config from server secrets', () => {
  const config = readRuntimeConfig({
    SAAS_DEPLOYMENT_ID: 'pilot-ve-001',
    SAAS_COUNTRY_CODE: 've',
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    SUPABASE_SECRET_KEY: 'server-secret'
  });
  const publicConfig = publicRuntimeConfig(config);
  assert.equal(config.countryCode, 'VE');
  assert.equal(config.supabaseUrl, 'https://example.supabase.co');
  assert.equal(publicConfig.supabasePublishableKey, 'sb_publishable_test');
  assert.equal('supabaseSecretKey' in publicConfig, false);
});

test('base AccessProvider refuses unimplemented state changes', async () => {
  const provider = new AccessProvider({ id: 'test', kind: 'mock' });
  await assert.rejects(() => provider.setCredentialState(), error => error.code === 'ACCESS_PROVIDER_NOT_IMPLEMENTED');
});

test('MKJ adapter maps neutral enable/disable commands to the existing MKJ client', async () => {
  const calls = [];
  const mockClient = {
    async mkjSetMemberStatus(memberId, action, options) {
      calls.push({ memberId, action, options });
      return { status: 200, providerStatus: 200, resolvedMemberId: memberId, idempotent: action === 'enable', recoveredMemberId: false };
    },
    async listOrganizationUsers() {
      return { users: [{ id: '77', email: 'owner@example.com' }] };
    },
    organizationUserId(user) { return user.id; },
    organizationUserEmail(user) { return user.email; }
  };

  const provider = new MkjAccessProvider({ client: mockClient });
  const enabled = await provider.setCredentialState({ externalCredentialId: '77', enabled: true, email: 'owner@example.com' });
  await provider.setCredentialState({ externalCredentialId: '77', enabled: false });
  const credentials = await provider.listCredentials();

  assert.equal(provider.supports('credential-state'), true);
  assert.equal(enabled.idempotent, true);
  assert.deepEqual(calls.map(call => call.action), ['enable', 'disable']);
  assert.deepEqual(credentials[0], { externalCredentialId: '77', email: 'owner@example.com', raw: { id: '77', email: 'owner@example.com' } });
});
