'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCountryPack } = require('../platform/core/country-pack');
const { validateManifest, buildProvisioningPlan } = require('../platform/provisioning/tenant-provisioning');

const root = path.join(__dirname, '..');
const ve = loadCountryPack(path.join(root, 'config', 'country-packs', 've.json'));
const example = JSON.parse(fs.readFileSync(path.join(root, 'config', 'tenant-provisioning', 've-pilot.example.json'), 'utf8'));

function clone(value) {
  return structuredClone(value);
}

test('VE pilot manifest validates and produces a deterministic commercial plan', () => {
  const normalized = validateManifest(example, ve);
  assert.equal(normalized.countryCode, 'VE');
  assert.deepEqual(normalized.currencies, { primary: 'VES', secondary: ['USD'] });
  const plan = buildProvisioningPlan(example, ve);
  assert.equal(plan.ownershipMode, 'client_owned');
  assert.equal(plan.accessProvider, 'mkj');
  assert.equal(plan.debtRestrictionAutomation, false);
  assert.ok(plan.steps.some(step => step.code === 'claim-or-transfer-data-plane'));
  assert.equal(plan.steps.at(-1).code, 'activate-tenant');
});

test('manifest can never contain secret-like fields', () => {
  for (const [field, value] of [
    ['service_role', 'x'], ['password', 'x'], ['oauthToken', 'x'], ['apiKey', 'x'], ['privateKey', 'x']
  ]) {
    const manifest = clone(example);
    manifest.deployment[field] = value;
    assert.throws(() => validateManifest(manifest, ve), error => error.code === 'PROVISIONING_SECRET_FIELD_FORBIDDEN');
  }
});

test('manifest must obey Country Pack timezone, currency and access providers', () => {
  const badTimezone = clone(example);
  badTimezone.localization.timezone = 'America/Bogota';
  assert.throws(() => validateManifest(badTimezone, ve), error => error.code === 'PROVISIONING_TIMEZONE_FORBIDDEN');

  const badCurrency = clone(example);
  badCurrency.localization.primaryCurrency = 'COP';
  assert.throws(() => validateManifest(badCurrency, ve), error => error.code === 'PROVISIONING_CURRENCY_FORBIDDEN');

  const badProvider = clone(example);
  badProvider.access.providerKind = 'magic-gate-9000';
  assert.throws(() => validateManifest(badProvider, ve), error => error.code === 'PROVISIONING_ACCESS_PROVIDER_FORBIDDEN');
});

test('VE pilot cannot activate debt-based access restrictions before Country Pack permits them', () => {
  const manifest = clone(example);
  manifest.access.debtRestrictionAutomation = true;
  manifest.access.legalApprovalRecorded = true;
  assert.throws(() => validateManifest(manifest, ve), error => error.code === 'PROVISIONING_DEBT_ACCESS_FORBIDDEN');
});

test('customer-owned deployment always includes claim/transfer; platform-owned does not', () => {
  const customer = buildProvisioningPlan(example, ve);
  assert.ok(customer.steps.some(step => step.code === 'claim-or-transfer-data-plane'));

  const platformOwned = clone(example);
  platformOwned.deployment.ownershipMode = 'platform_owned';
  const plan = buildProvisioningPlan(platformOwned, ve);
  assert.equal(plan.steps.some(step => step.code === 'claim-or-transfer-data-plane'), false);
});

test('all onboarding manifests require reconciliation before activation', () => {
  const manifest = clone(example);
  manifest.onboarding.reconciliationRequired = false;
  assert.throws(() => validateManifest(manifest, ve), error => error.code === 'PROVISIONING_RECONCILIATION_REQUIRED');
});
