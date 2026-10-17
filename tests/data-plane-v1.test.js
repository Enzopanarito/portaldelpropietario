'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'platform', 'database');
const schema = fs.readFileSync(path.join(root, 'data-plane-v1.schema.sql'), 'utf8');
const rls = fs.readFileSync(path.join(root, 'data-plane-v1.rls.sql'), 'utf8');

const rlsTables = [
  'schema_metadata','tenants','sites','structures','units','people','person_contacts',
  'user_identities','tenant_roles','unit_memberships','tenant_policy_versions',
  'financial_periods','charge_types','charges','payment_methods','payment_reports',
  'payments','payment_allocations','credit_memos','ledger_entries','receipts',
  'access_integrations','access_credentials','access_events','audit_events'
];

test('every exposed Data Plane table has RLS enabled', () => {
  for (const table of rlsTables) {
    assert.match(rls, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'), table);
  }
});

test('authorization helpers are SECURITY INVOKER and never SECURITY DEFINER', () => {
  assert.doesNotMatch(schema + rls, /security\s+definer/i);
  assert.match(rls, /security\s+invoker/i);
});

test('ledger is append-only and balances are derived per currency', () => {
  assert.match(schema, /ledger_entries_append_only/i);
  assert.match(schema, /reject_immutable_mutation/i);
  assert.match(schema, /group by tenant_id, unit_id, currency_code/i);
  assert.match(schema, /security_invoker\s*=\s*true/i);
  assert.match(schema, /Balances never net across currencies/i);
});

test('tenant boundaries are enforced by composite foreign keys', () => {
  assert.match(schema, /foreign key \(tenant_id, unit_id\) references public\.units\(tenant_id, id\)/i);
  assert.match(schema, /foreign key \(tenant_id, credential_id\) references public\.access_credentials\(tenant_id, id\)/i);
  assert.match(schema, /foreign key \(tenant_id, reversal_of\) references public\.ledger_entries\(tenant_id, id\)/i);
});

test('biometric templates cannot be stored in the generic access credential metadata', () => {
  for (const forbidden of ['biometric_template','fingerprint','face_template','iris_template']) {
    assert.match(schema, new RegExp(forbidden, 'i'));
  }
  assert.match(schema, /not \(metadata \?\| array\[/i);
});

test('Data API exposure is explicit and anon receives no table grants', () => {
  assert.match(rls, /revoke all on table[\s\S]*from anon, authenticated;/i);
  assert.match(rls, /grant select on table[\s\S]*to authenticated;/i);
  assert.match(rls, /grant insert on table public\.payment_reports to authenticated;/i);
});

test('resident payment reports must be pending and bound to auth.uid()', () => {
  assert.match(rls, /payment_reports_resident_insert/i);
  assert.match(rls, /reported_by_auth_user_id = \(select auth\.uid\(\)\)/i);
  assert.match(rls, /state = 'pending'/i);
  assert.match(rls, /current_user_has_unit\(tenant_id, unit_id\)/i);
});
