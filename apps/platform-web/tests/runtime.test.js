import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPublicSecretEnv, getRuntimeSummary } from '../lib/runtime.js';

test('runtime declares Vercel target and dedicated Supabase data planes', () => {
  const runtime = getRuntimeSummary({ PLATFORM_ENVIRONMENT: 'preview', VERCEL_GIT_COMMIT_SHA: 'abc123' });
  assert.equal(runtime.hostingTarget, 'vercel');
  assert.equal(runtime.tenantRoutingMode, 'control-plane-registry');
  assert.equal(runtime.dataPlaneIsolation, 'dedicated-supabase-project');
  assert.equal(runtime.version, 'abc123');
});

test('invalid platform environment fails closed', () => {
  assert.throws(() => getRuntimeSummary({ PLATFORM_ENVIRONMENT: 'banana' }), (error) => error.code === 'PLATFORM_ENVIRONMENT_INVALID');
});

test('server secrets may never be declared NEXT_PUBLIC', () => {
  assert.equal(assertNoPublicSecretEnv({ NEXT_PUBLIC_SUPABASE_URL: 'safe-project-url' }), true);
  assert.throws(
    () => assertNoPublicSecretEnv({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'forbidden' }),
    (error) => error.code === 'PUBLIC_SECRET_ENV_FORBIDDEN'
  );
});
