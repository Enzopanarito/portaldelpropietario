const ALLOWED_ENVIRONMENTS = new Set(['development', 'preview', 'production']);

export function getRuntimeSummary(env = process.env) {
  const platformEnvironment = env.PLATFORM_ENVIRONMENT || 'development';
  if (!ALLOWED_ENVIRONMENTS.has(platformEnvironment)) {
    throw Object.assign(new Error('Invalid PLATFORM_ENVIRONMENT'), { code: 'PLATFORM_ENVIRONMENT_INVALID' });
  }

  return Object.freeze({
    application: 'regional-community-platform',
    hostingTarget: 'vercel',
    platformEnvironment,
    tenantRoutingMode: 'control-plane-registry',
    dataPlaneIsolation: 'dedicated-supabase-project',
    version: env.VERCEL_GIT_COMMIT_SHA || 'local'
  });
}

export function assertNoPublicSecretEnv(env = process.env) {
  const forbiddenPublicKeys = Object.keys(env).filter((key) =>
    key.startsWith('NEXT_PUBLIC_') && /(SECRET|SERVICE_ROLE|PRIVATE|TOKEN|PASSWORD)/i.test(key)
  );
  if (forbiddenPublicKeys.length) {
    throw Object.assign(new Error(`Server secrets cannot be public: ${forbiddenPublicKeys.join(', ')}`), {
      code: 'PUBLIC_SECRET_ENV_FORBIDDEN'
    });
  }
  return true;
}
