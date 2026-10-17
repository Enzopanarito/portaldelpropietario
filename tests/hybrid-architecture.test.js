'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadCountryPack } = require('../platform/core/country-pack');
const { validateManifest, buildProvisioningPlan } = require('../platform/provisioning/tenant-provisioning');
const root = path.join(__dirname, '..');
const country = loadCountryPack(path.join(root, 'config/country-packs/ve.json'));
const shared = JSON.parse(fs.readFileSync(path.join(root, 'config/tenant-provisioning/ve-shared.example.json'), 'utf8'));
const sql = fs.readFileSync(path.join(root, 'platform/control-plane/migrations/control-plane-v1-hybrid-01-pools.sql'), 'utf8');
const clone = value => structuredClone(value);

test('shared mode has one platform-owned pool and tenant-specific onboarding', () => {
  const normalized = validateManifest(shared, country);
  assert.equal(normalized.dataPlaneMode, 'shared');
  const plan = buildProvisioningPlan(shared, country);
  assert.equal(plan.dataPlaneMode, 'shared');
  assert.ok(plan.steps.some(step => step.code === 'select-compatible-shared-pool'));
  assert.ok(plan.steps.some(step => step.code === 'register-tenant-in-data-plane'));
  assert.ok(plan.steps.some(step => step.code === 'reconcile-opening-state'));
  assert.ok(!plan.steps.some(step => step.code === 'create-or-attach-data-plane'));
  assert.ok(!plan.steps.some(step => step.code === 'claim-or-transfer-data-plane'));
});

test('shared mode cannot transfer company pool or delegate pool migrations to customer', () => {
  const x = clone(shared);
  x.deployment.ownershipMode = 'client_owned';
  assert.throws(() => validateManifest(x, country), e => e.code === 'PROVISIONING_SHARED_OWNERSHIP_INVALID');
  const y = clone(shared);
  y.deployment.migrationMode = 'client_managed';
  assert.throws(() => validateManifest(y, country), e => e.code === 'PROVISIONING_SHARED_MIGRATION_INVALID');
});

test('database enforces one dedicated tenant per pool and country-matched bindings', () => {
  assert.match(sql, /unique index tenant_pool_only_one_dedicated/i);
  assert.match(sql, /where pool_mode = 'dedicated'/i);
  assert.match(sql, /foreign key \(tenant_id, country_code\)/i);
  assert.match(sql, /foreign key \(pool_id, country_code, pool_mode\)/i);
  assert.match(sql, /pool_mode = 'dedicated' or ownership_mode = 'platform_owned'/i);
  for (const table of ['data_plane_pools', 'tenant_pool_bindings']) {
    assert.match(sql, new RegExp('alter table platform_control\\.' + table + ' enable row level security;', 'i'));
    assert.match(sql, new RegExp('create policy control_.*_deny_client on platform_control\\.' + table, 'i'));
  }
});
