'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'platform', 'control-plane', 'control-plane-v1.schema.sql'), 'utf8');
const docs = fs.readFileSync(path.join(__dirname, '..', 'platform', 'control-plane', 'CONTROL_PLANE_V1.md'), 'utf8');

const controlTables = [
  'tenants','tenant_domains','encrypted_secrets','data_planes','distributors',
  'tenant_distributors','release_compatibility','audit_events'
];

test('Control Plane contains routing/commercial metadata but no resident finance tables', () => {
  for (const table of controlTables) assert.match(schema, new RegExp(`platform_control\\.${table}`, 'i'));
  assert.doesNotMatch(schema, /create table if not exists platform_control\.(charges|payments|ledger_entries|receipts|people|units|unit_memberships)\b/i);
  assert.match(docs, /What never belongs here/i);
});

test('all Control Plane tables have RLS and explicit client deny policies', () => {
  for (const table of controlTables) {
    assert.match(schema, new RegExp(`alter table platform_control\\.${table} enable row level security;`, 'i'));
  }
  const denyPolicies = schema.match(/create policy control_[^\n]+deny_client/gi) || [];
  assert.equal(denyPolicies.length, controlTables.length);
  assert.match(schema, /revoke all on all tables in schema platform_control from public, anon, authenticated;/i);
});

test('secret material is ciphertext-only and cross-tenant secret references are constrained', () => {
  assert.match(schema, /AES-256-GCM/);
  assert.match(schema, /ciphertext_b64 text not null/i);
  assert.match(schema, /auth_tag_b64 text not null/i);
  assert.match(schema, /foreign key \(tenant_id, management_oauth_secret_id\) references platform_control\.encrypted_secrets\(tenant_id, id\)/i);
  assert.match(schema, /foreign key \(tenant_id, database_password_secret_id\) references platform_control\.encrypted_secrets\(tenant_id, id\)/i);
  assert.doesNotMatch(schema, /plaintext|raw_token|raw_password/i);
});

test('Control Plane authorization never uses SECURITY DEFINER', () => {
  assert.doesNotMatch(schema, /security\s+definer/i);
  assert.match(schema, /security\s+invoker/i);
});

test('Supabase ownership/migration modes are explicit instead of implicit fallbacks', () => {
  assert.match(schema, /platform_owned','client_owned','client_admin_owned/);
  assert.match(schema, /project_claim','oauth_connected','platform_managed','client_managed/);
  assert.match(schema, /platform_api','database_password','client_managed/);
  assert.match(docs, /must not assume OAuth alone grants arbitrary SQL execution/i);
});
