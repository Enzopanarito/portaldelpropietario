'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadCountryPackObject } = require('../platform/core/country-pack');
const { validateTenantPolicy } = require('../platform/core/tenant-policy');

const vePack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'country-packs', 've.json'), 'utf8'));
const safePolicy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tenant-policies', 've-pilot.example.json'), 'utf8'));

test('safe VE pilot policy validates while debt-based access remains off', () => {
  const result = validateTenantPolicy(safePolicy, loadCountryPackObject(vePack));
  assert.equal(result.countryCode, 'VE');
  assert.equal(result.access.provider, 'mkj');
  assert.equal(result.access.debtRestriction.enabled, false);
  assert.equal(Object.isFrozen(result), true);
});

test('VE pilot cannot enable debt-based physical restriction before Country Pack legal review', () => {
  const policy = structuredClone(safePolicy);
  policy.access.debtRestriction = {
    enabled: true,
    legalApproval: {
      approved: true,
      reference: 'LEGAL-001',
      reviewedBy: 'Local counsel',
      reviewDate: '2026-10-17'
    }
  };
  assert.throws(
    () => validateTenantPolicy(policy, loadCountryPackObject(vePack)),
    error => error.code === 'ACCESS_DEBT_COUNTRY_REVIEW_REQUIRED'
  );
});

test('Country Pack can hard-disable debt-based access regardless of tenant preference', () => {
  const pack = structuredClone(vePack);
  pack.collections.physicalAccessRestrictionByDebt = 'disabled';
  const policy = structuredClone(safePolicy);
  policy.access.debtRestriction.enabled = true;
  assert.throws(
    () => validateTenantPolicy(policy, loadCountryPackObject(pack)),
    error => error.code === 'ACCESS_DEBT_RESTRICTION_DISABLED'
  );
});

test('conditionally allowed access still requires tenant legal approval', () => {
  const pack = structuredClone(vePack);
  pack.collections.physicalAccessRestrictionByDebt = 'conditionally-allowed';
  pack.legalValidation = { reviewedBy: 'Country counsel', reviewDate: '2026-10-17' };
  const policy = structuredClone(safePolicy);
  policy.access.debtRestriction.enabled = true;
  assert.throws(
    () => validateTenantPolicy(policy, loadCountryPackObject(pack)),
    error => error.code === 'ACCESS_DEBT_TENANT_REVIEW_REQUIRED'
  );
  policy.access.debtRestriction.legalApproval = {
    approved: true,
    reference: 'BOARD-LEGAL-2026-01',
    reviewedBy: 'Tenant counsel',
    reviewDate: '2026-10-17'
  };
  assert.equal(validateTenantPolicy(policy, loadCountryPackObject(pack)).access.debtRestriction.enabled, true);
});

test('tenant cannot invent payment rails, currencies, timezones or access providers', () => {
  for (const [mutate, code] of [
    [p => p.payments.enabledRails.push('pix'), 'TENANT_POLICY_PAYMENT_RAIL_NOT_ALLOWED'],
    [p => p.currencies.push('COP'), 'TENANT_POLICY_CURRENCY_NOT_ALLOWED'],
    [p => { p.timezone = 'America/Bogota'; }, 'TENANT_POLICY_TIMEZONE_NOT_ALLOWED'],
    [p => { p.access.provider = 'unknown-gate'; }, 'TENANT_POLICY_ACCESS_PROVIDER_NOT_ALLOWED']
  ]) {
    const policy = structuredClone(safePolicy);
    mutate(policy);
    assert.throws(() => validateTenantPolicy(policy, loadCountryPackObject(vePack)), error => error.code === code, code);
  }
});
