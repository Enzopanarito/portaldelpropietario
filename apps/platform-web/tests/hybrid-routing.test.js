import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlPlaneRegistry } from '../lib/server/control-plane-registry.js';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POOL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
const json = v => new Response(JSON.stringify(v), {headers: {'content-type':'application/json'}});

function fakeFetch({poolCountry = 'VE', poolMode = 'shared'} = {}) {
  return async function(url) {
    const u = new URL(url);
    const q = u.searchParams;
    if (u.pathname.endsWith('/tenant_domains')) {
      const host = q.get('hostname').replace('eq.', '');
      if (host === 'a.example.com') return json([{tenant_id:A,status:'verified'}]);
      if (host === 'b.example.com') return json([{tenant_id:B,status:'verified'}]);
      return json([]);
    }
    if (u.pathname.endsWith('/tenants')) {
      const id = q.get('id').replace('eq.', '');
      return json([{id,slug:id===A?'building-a':'building-b',display_name:id===A?'Building A':'Building B',country_code:'VE',country_pack_version:'0.1.0',status:'active'}]);
    }
    if (u.pathname.endsWith('/tenant_pool_bindings')) {
      return json([{pool_id:POOL,pool_mode:'shared',country_code:'VE',status:'active'}]);
    }
    if (u.pathname.endsWith('/data_plane_pools')) {
      return json([{project_url:SUPABASE_URL,publishable_key:'sb_publishable_dummy',lifecycle_status:'healthy',schema_version:'1.0.0',country_code:poolCountry,pool_mode:poolMode}]);
    }
    throw new Error('Unexpected route: ' + u.pathname);
  };
}

test('two independently branded tenants use the same physical shared Supabase', async () => {
  const reg = createControlPlaneRegistry({baseUrl:'https://control.example.com',secretKey:'sb_secret_test-only',fetchImpl:fakeFetch()});
  const a = await reg.lookupByHostname('a.example.com');
  const b = await reg.lookupByHostname('b.example.com');
  assert.equal(a.tenantId, A);
  assert.equal(b.tenantId, B);
  assert.notEqual(a.tenantId,b.tenantId);
  assert.notEqual(a.displayName,b.displayName);
  assert.equal(a.projectUrl, b.projectUrl);
  assert.equal(a.publishableKey,b.publishableKey);
});
test('registry never routes tenant to a pool of a different country or mode', async () => {
  for (const overrides of [{poolCountry:'CO'},{poolMode:'dedicated'}]) {
    const reg = createControlPlaneRegistry({baseUrl:'https://control.example.com',secretKey:'sb_secret_test-only',fetchImpl:fakeFetch(overrides)});
    assert.equal(await reg.lookupByHostname('a.example.com'), null);
  }
});
