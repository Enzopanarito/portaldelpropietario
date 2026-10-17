import { domainToASCII } from 'node:url';

const SAFE_CAPABILITIES = new Set(['payments','access','notifications','documents','ai','maintenance','reservations']);

export function normalizeHostname(input) {
  const raw = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  const withoutPort = raw.startsWith('[') ? raw : raw.replace(/:\d+$/, '');
  const ascii = domainToASCII(withoutPort);
  if (!ascii || ascii.length > 253 || ascii.includes('/') || ascii.includes('\\')) {
    throw Object.assign(new Error('Invalid tenant hostname'), { code: 'TENANT_HOST_INVALID' });
  }
  const labels = ascii.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw Object.assign(new Error('Invalid tenant hostname'), { code: 'TENANT_HOST_INVALID' });
  }
  return ascii;
}

export function validateDataPlaneRecord(record) {
  if (!record || typeof record !== 'object') {
    throw Object.assign(new Error('Data Plane record is required'), { code: 'DATA_PLANE_REQUIRED' });
  }
  const url = new URL(record.projectUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('Data Plane URL must be a clean HTTPS origin'), { code: 'DATA_PLANE_URL_INVALID' });
  }
  if (!String(record.publishableKey || '').startsWith('sb_publishable_')) {
    throw Object.assign(new Error('Modern Supabase publishable key required'), { code: 'DATA_PLANE_PUBLISHABLE_KEY_INVALID' });
  }
  if (!/^[a-z0-9-]{3,64}$/.test(String(record.tenantSlug || ''))) {
    throw Object.assign(new Error('Invalid tenant slug'), { code: 'TENANT_SLUG_INVALID' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(record.tenantId || ''))) {
    throw Object.assign(new Error('Invalid tenant id'), { code: 'TENANT_ID_INVALID' });
  }
  if (!/^[A-Z]{2}$/i.test(String(record.countryCode || ''))) {
    throw Object.assign(new Error('Invalid country code'), { code: 'TENANT_COUNTRY_INVALID' });
  }
  if (!String(record.displayName || '').trim() || !String(record.countryPackVersion || '').trim()) {
    throw Object.assign(new Error('Tenant display name and Country Pack version are required'), { code: 'TENANT_METADATA_INVALID' });
  }
  return true;
}

export function buildPublicTenantBootstrap(record) {
  validateDataPlaneRecord(record);
  const capabilities = [...new Set((record.capabilities || []).map(String))]
    .filter(value => SAFE_CAPABILITIES.has(value))
    .sort();

  return Object.freeze({
    tenantId: String(record.tenantId),
    tenantSlug: String(record.tenantSlug),
    displayName: String(record.displayName),
    countryCode: String(record.countryCode).toUpperCase(),
    countryPackVersion: String(record.countryPackVersion),
    supabaseUrl: new URL(record.projectUrl).origin,
    supabasePublishableKey: String(record.publishableKey),
    authStorageKey: `rcp:${record.tenantSlug}:auth`,
    capabilities
  });
}

export async function resolveTenantBootstrap({ host, lookupByHostname }) {
  if (typeof lookupByHostname !== 'function') {
    throw Object.assign(new Error('Tenant registry lookup is required'), { code: 'TENANT_REGISTRY_REQUIRED' });
  }
  const hostname = normalizeHostname(host);
  const record = await lookupByHostname(hostname);
  if (!record || record.status !== 'active' || record.domainStatus !== 'verified') {
    throw Object.assign(new Error('Tenant not available'), { code: 'TENANT_NOT_AVAILABLE' });
  }
  return buildPublicTenantBootstrap(record);
}
