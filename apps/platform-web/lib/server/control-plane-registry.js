import { normalizeHostname } from './tenant-bootstrap.js';

function required(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
  return value;
}

function controlPlaneHeaders(secretKey, profile = 'platform_control') {
  return {
    apikey: secretKey,
    'Accept-Profile': profile,
    Accept: 'application/json'
  };
}

async function fetchSingle({ fetchImpl, baseUrl, path, secretKey }) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: 'GET',
    headers: controlPlaneHeaders(secretKey),
    cache: 'no-store'
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Control Plane query failed: ${response.status}`), {
      code: 'CONTROL_PLANE_QUERY_FAILED',
      status: response.status
    });
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export function createControlPlaneRegistry({ baseUrl, secretKey, fetchImpl = fetch }) {
  const normalizedBaseUrl = new URL(required(baseUrl, 'CONTROL_PLANE_URL_REQUIRED'));
  if (normalizedBaseUrl.protocol !== 'https:') {
    throw Object.assign(new Error('Control Plane URL must use HTTPS'), { code: 'CONTROL_PLANE_URL_INVALID' });
  }
  if (!String(required(secretKey, 'CONTROL_PLANE_SECRET_REQUIRED')).startsWith('sb_secret_')) {
    throw Object.assign(new Error('Modern Supabase secret key required'), { code: 'CONTROL_PLANE_SECRET_INVALID' });
  }

  return Object.freeze({
    async lookupByHostname(input) {
      const hostname = normalizeHostname(input);
      const encodedHost = encodeURIComponent(hostname);
      const domain = await fetchSingle({
        fetchImpl,
        baseUrl: normalizedBaseUrl,
        secretKey,
        path: `/rest/v1/tenant_domains?select=tenant_id,status&hostname=eq.${encodedHost}&limit=1`
      });
      if (!domain) return null;

      const tenantId = encodeURIComponent(domain.tenant_id);
      const tenant = await fetchSingle({
        fetchImpl,
        baseUrl: normalizedBaseUrl,
        secretKey,
        path: `/rest/v1/tenants?select=id,slug,display_name,country_code,country_pack_version,status&id=eq.${tenantId}&limit=1`
      });
      if (!tenant) return null;

      const dataPlane = await fetchSingle({
        fetchImpl,
        baseUrl: normalizedBaseUrl,
        secretKey,
        path: `/rest/v1/data_planes?select=project_url,publishable_key,lifecycle_status,schema_version&tenant_id=eq.${tenantId}&limit=1`
      });
      if (!dataPlane || dataPlane.lifecycle_status !== 'healthy') return null;

      return {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        displayName: tenant.display_name,
        countryCode: tenant.country_code,
        countryPackVersion: tenant.country_pack_version,
        status: tenant.status,
        domainStatus: domain.status,
        projectUrl: dataPlane.project_url,
        publishableKey: dataPlane.publishable_key,
        schemaVersion: dataPlane.schema_version,
        capabilities: []
      };
    }
  });
}

export function createControlPlaneRegistryFromEnv(env = process.env, options = {}) {
  return createControlPlaneRegistry({
    baseUrl: env.CONTROL_PLANE_SUPABASE_URL,
    secretKey: env.CONTROL_PLANE_SUPABASE_SECRET_KEY,
    ...options
  });
}
