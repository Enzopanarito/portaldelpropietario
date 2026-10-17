import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneRegistry } from '../lib/server/control-plane-registry.js';
import { createTenantBootstrapHandler } from '../lib/server/tenant-bootstrap-handler.js';

const SECRET = 'sb_secret_test-only-not-real';
const BASE = 'https://control.example.supabase.co';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function healthyRows() {
  return [
    [{ tenant_id: TENANT_ID, status: 'verified' }],
    [{ id: TENANT_ID, slug: 'residencias-a', display_name: 'Residencias A', country_code: 'VE', country_pack_version: 'VE-0.1', status: 'active' }],
    [],
    [{ project_url: 'https://abcdefghijklmnopqrst.supabase.co', publishable_key: 'sb_publishable_example', lifecycle_status: 'healthy', schema_version: '1.0.0' }]
  ];
}

test('registry uses apikey-only secret auth and custom schema profile', async () => {
  const calls = [];
  const rows = healthyRows();
  const registry = createControlPlaneRegistry({
    baseUrl: BASE,
    secretKey: SECRET,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(rows[calls.length - 1]);
    }
  });

  const record = await registry.lookupByHostname('Portal.Example.COM:443');
  assert.equal(record.tenantSlug, 'residencias-a');
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.init.headers.apikey, SECRET);
    assert.equal(call.init.headers['Accept-Profile'], 'platform_control');
    assert.equal('Authorization' in call.init.headers, false);
    assert.equal(call.init.cache, 'no-store');
  }
  assert.match(calls[0].url, /hostname=eq\.portal\.example\.com/);
  assert.doesNotMatch(JSON.stringify(record), /sb_secret_/);
});

test('unhealthy Data Plane is treated as unavailable', async () => {
  const rows = healthyRows();
  rows[3][0].lifecycle_status = 'degraded';
  let index = 0;
  const registry = createControlPlaneRegistry({
    baseUrl: BASE,
    secretKey: SECRET,
    fetchImpl: async () => jsonResponse(rows[index++])
  });
  assert.equal(await registry.lookupByHostname('portal.example.com'), null);
});

test('registry rejects missing/legacy server credentials before any request', () => {
  assert.throws(
    () => createControlPlaneRegistry({ baseUrl: BASE, secretKey: '' }),
    error => error.code === 'CONTROL_PLANE_SECRET_REQUIRED'
  );
  assert.throws(
    () => createControlPlaneRegistry({ baseUrl: BASE, secretKey: 'legacy-service-role-jwt' }),
    error => error.code === 'CONTROL_PLANE_SECRET_INVALID'
  );
  assert.throws(
    () => createControlPlaneRegistry({ baseUrl: 'http://control.example.com', secretKey: SECRET }),
    error => error.code === 'CONTROL_PLANE_URL_INVALID'
  );
});

test('bootstrap handler returns only safe tenant data', async () => {
  const registryFactory = () => ({
    lookupByHostname: async () => ({
      tenantId: TENANT_ID,
      tenantSlug: 'residencias-a',
      displayName: 'Residencias A',
      countryCode: 'VE',
      countryPackVersion: 'VE-0.1',
      status: 'active',
      domainStatus: 'verified',
      projectUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      publishableKey: 'sb_publishable_example',
      capabilities: ['payments', 'access'],
      controlPlaneSecret: SECRET,
      databasePassword: 'never-return-this'
    })
  });
  const handler = createTenantBootstrapHandler({ registryFactory });
  const response = await handler(new Request('https://platform.example/api/tenant/bootstrap', {
    headers: { host: 'portal.example.com' }
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.tenant.tenantSlug, 'residencias-a');
  assert.equal(body.tenant.supabasePublishableKey, 'sb_publishable_example');
  assert.doesNotMatch(JSON.stringify(body), /sb_secret_|never-return-this/);
});

test('bootstrap handler fails closed without leaking upstream details', async () => {
  const upstream = createTenantBootstrapHandler({
    registryFactory: () => ({
      lookupByHostname: async () => {
        throw Object.assign(new Error(`upstream exploded with ${SECRET}`), { code: 'CONTROL_PLANE_QUERY_FAILED' });
      }
    })
  });
  const response = await upstream(new Request('https://platform.example/api/tenant/bootstrap', {
    headers: { host: 'portal.example.com' }
  }));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /TENANT_REGISTRY_UPSTREAM_UNAVAILABLE/);
  assert.doesNotMatch(text, /CONTROL_PLANE_QUERY_FAILED|sb_secret_|upstream exploded/);

  const missingEnv = createTenantBootstrapHandler({
    registryFactory: () => createControlPlaneRegistry({ baseUrl: '', secretKey: '' })
  });
  const unavailable = await missingEnv(new Request('https://platform.example/api/tenant/bootstrap', {
    headers: { host: 'portal.example.com' }
  }));
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /CONTROL_PLANE_URL_REQUIRED|CONTROL_PLANE_SECRET_REQUIRED/);
});
