'use strict';

const { validateCountryPack, normalizeCountryCode } = require('../core/country-pack');

const SUPABASE_REGIONS = new Set([
  'us-west-1','us-east-1','us-east-2','ca-central-1',
  'eu-west-1','eu-west-2','eu-west-3','eu-central-1','eu-central-2','eu-north-1',
  'ap-south-1','ap-southeast-1','ap-northeast-1','ap-northeast-2','ap-southeast-2','sa-east-1'
]);
const OWNERSHIP_MODES = new Set(['platform_owned','client_owned','client_admin_owned']);
const MIGRATION_MODES = new Set(['platform_api','database_password','client_managed','platform_managed']);
const DATA_PLANE_MODES = new Set(['shared','dedicated']);
const MODULES = new Set(['payments','access','notifications','documents','ai','maintenance','reservations']);
const FORBIDDEN_SECRET_KEY = /(secret|password|token|service[_-]?role|private[_-]?key|api[_-]?key)/i;

function invariant(condition, message, code = 'PROVISIONING_MANIFEST_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walkForSecrets(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    invariant(!FORBIDDEN_SECRET_KEY.test(key), `Secret-like field is forbidden in manifest: ${path}.${key}`, 'PROVISIONING_SECRET_FIELD_FORBIDDEN');
    walkForSecrets(nested, `${path}.${key}`);
  }
}

function normalizeHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  invariant(hostname.length >= 3 && hostname.length <= 253, 'Invalid hostname', 'PROVISIONING_HOST_INVALID');
  invariant(!hostname.includes('/') && !hostname.includes(':') && !hostname.includes('\\'), 'Hostname must not contain path or port', 'PROVISIONING_HOST_INVALID');
  invariant(hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), 'Invalid hostname labels', 'PROVISIONING_HOST_INVALID');
  return hostname;
}

function normalizeCurrencies(manifest, countryPack) {
  const primary = String(manifest.localization?.primaryCurrency || '').toUpperCase();
  const secondary = [...new Set((manifest.localization?.secondaryCurrencies || []).map(value => String(value).toUpperCase()))];
  invariant(countryPack.currency.allowed.includes(primary), `Primary currency ${primary} is not allowed by Country Pack`, 'PROVISIONING_CURRENCY_FORBIDDEN');
  invariant(secondary.every(code => countryPack.currency.allowed.includes(code)), 'Secondary currency is not allowed by Country Pack', 'PROVISIONING_CURRENCY_FORBIDDEN');
  invariant(!secondary.includes(primary), 'Primary currency cannot also be secondary', 'PROVISIONING_CURRENCY_DUPLICATE');
  return { primary, secondary };
}

function validateManifest(manifest, countryPack) {
  invariant(isPlainObject(manifest), 'Provisioning manifest must be an object');
  validateCountryPack(countryPack);
  walkForSecrets(manifest);

  invariant(manifest.schemaVersion === '1.0', 'Unsupported provisioning schemaVersion');
  invariant(isPlainObject(manifest.tenant), 'tenant is required');
  invariant(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(String(manifest.tenant.slug || '')), 'Invalid tenant slug');
  invariant(Boolean(String(manifest.tenant.displayName || '').trim()), 'tenant.displayName is required');
  const countryCode = normalizeCountryCode(manifest.tenant.countryCode);
  invariant(countryCode === countryPack.countryCode, 'Manifest country does not match Country Pack', 'PROVISIONING_COUNTRY_MISMATCH');

  invariant(isPlainObject(manifest.deployment), 'deployment is required');
  invariant(SUPABASE_REGIONS.has(manifest.deployment.supabaseRegion), 'Unsupported Supabase region', 'PROVISIONING_REGION_INVALID');
  invariant(OWNERSHIP_MODES.has(manifest.deployment.ownershipMode), 'Invalid ownership mode', 'PROVISIONING_OWNERSHIP_INVALID');
  invariant(MIGRATION_MODES.has(manifest.deployment.migrationMode), 'Invalid migration mode', 'PROVISIONING_MIGRATION_MODE_INVALID');
  const dataPlaneMode = manifest.deployment.dataPlaneMode || 'dedicated';
  invariant(DATA_PLANE_MODES.has(dataPlaneMode), 'Unknown Data Plane mode', 'PROVISIONING_DATA_PLANE_MODE_INVALID');
  if (dataPlaneMode === 'shared') {
    invariant(manifest.deployment.ownershipMode === 'platform_owned', 'Shared pools must belong to platform', 'PROVISIONING_SHARED_OWNERSHIP_INVALID');
    invariant(manifest.deployment.migrationMode === 'platform_managed', 'Shared pools are migrated by platform', 'PROVISIONING_SHARED_MIGRATION_INVALID');
  }
  invariant(manifest.deployment.vercelRuntime === 'regional-shared', 'Vercel runtime must be regional-shared', 'PROVISIONING_VERCEL_MODE_INVALID');
  invariant(/^\d+\.\d+\.\d+$/.test(String(manifest.deployment.desiredSchemaVersion || '')), 'desiredSchemaVersion must be semver');

  invariant(isPlainObject(manifest.localization), 'localization is required');
  invariant((countryPack.locale.allowedTimezones || [countryPack.locale.defaultTimezone]).includes(manifest.localization.timezone), 'Timezone is not allowed by Country Pack', 'PROVISIONING_TIMEZONE_FORBIDDEN');
  const currencies = normalizeCurrencies(manifest, countryPack);

  invariant(isPlainObject(manifest.domain), 'domain is required');
  const hostname = normalizeHostname(manifest.domain.hostname);
  invariant(manifest.domain.status === 'pending', 'New domain must begin pending verification', 'PROVISIONING_DOMAIN_STATE_INVALID');

  const modules = [...new Set((manifest.modules || []).map(String))].sort();
  invariant(modules.length > 0, 'At least one module is required');
  invariant(modules.every(module => MODULES.has(module)), 'Unknown module requested', 'PROVISIONING_MODULE_INVALID');

  invariant(isPlainObject(manifest.access), 'access is required');
  invariant(countryPack.access.allowedProviderKinds.includes(manifest.access.providerKind), 'Access provider is not allowed by Country Pack', 'PROVISIONING_ACCESS_PROVIDER_FORBIDDEN');
  invariant(manifest.access.storeBiometricTemplatesInCore !== true, 'Raw biometric templates are forbidden in Core', 'PROVISIONING_BIOMETRIC_CORE_FORBIDDEN');
  if (manifest.access.debtRestrictionAutomation === true) {
    invariant(countryPack.collections.physicalAccessRestrictionByDebt === 'conditionally-allowed', 'Country Pack does not permit debt restriction automation', 'PROVISIONING_DEBT_ACCESS_FORBIDDEN');
    invariant(manifest.access.legalApprovalRecorded === true, 'Debt restriction requires recorded tenant legal approval', 'PROVISIONING_DEBT_ACCESS_APPROVAL_REQUIRED');
  }

  invariant(isPlainObject(manifest.onboarding), 'onboarding is required');
  invariant(['csv','xlsx','manual','api'].includes(manifest.onboarding.source), 'Unsupported onboarding source');
  invariant(manifest.onboarding.reconciliationRequired === true, 'Opening data must require reconciliation', 'PROVISIONING_RECONCILIATION_REQUIRED');

  return Object.freeze({ countryCode, hostname, currencies, modules, dataPlaneMode });
}

function buildProvisioningPlan(manifest, countryPack) {
  const normalized = validateManifest(manifest, countryPack);
  const shared = normalized.dataPlaneMode === 'shared';
  const transferNeeded = !shared && manifest.deployment.ownershipMode !== 'platform_owned';
  const steps = [
    ['validate-country-pack', 'Validate country rules and sensitive legal gates'],
    shared ? ['select-compatible-shared-pool', 'Select healthy platform-owned pool by country and region'] : ['create-or-attach-data-plane', 'Create or attach the dedicated Supabase Data Plane'],
    shared ? ['verify-shared-pool-schema', 'Verify existing pool schema and capacity'] : ['apply-data-plane-schema', `Apply Data Plane schema ${manifest.deployment.desiredSchemaVersion}`],
    ['run-supabase-advisors', 'Require clean security advisors and review performance advisors'],
    ['register-control-plane', 'Register tenant/domain/Data Plane metadata without resident data'],
    ['register-tenant-in-data-plane', 'Create matching tenant identity in assigned Data Plane before any import'],
    ['import-onboarding-data', `Import onboarding source: ${manifest.onboarding.source}`],
    ['reconcile-opening-state', 'Reconcile units, identities and opening balances per currency'],
    ['configure-tenant-services', 'Configure Auth, Storage, payment rails and provider adapters'],
    ['access-dry-run', 'Run access provider reconciliation in dry-run mode'],
    ...(transferNeeded ? [['claim-or-transfer-data-plane', 'Transfer/claim Data Plane into customer-owned Supabase organization']] : []),
    ['verify-release-compatibility', 'Verify web release, schema and privileged bundle compatibility'],
    ['activate-tenant', 'Verify domain and activate tenant routing']
  ];

  return Object.freeze({
    schemaVersion: '1.0',
    tenantSlug: manifest.tenant.slug,
    countryCode: normalized.countryCode,
    hostname: normalized.hostname,
    supabaseRegion: manifest.deployment.supabaseRegion,
    ownershipMode: manifest.deployment.ownershipMode,
    dataPlaneMode: normalized.dataPlaneMode,
    migrationMode: manifest.deployment.migrationMode,
    desiredSchemaVersion: manifest.deployment.desiredSchemaVersion,
    currencies: normalized.currencies,
    modules: normalized.modules,
    accessProvider: manifest.access.providerKind,
    debtRestrictionAutomation: manifest.access.debtRestrictionAutomation === true,
    steps: steps.map(([code, description], index) => ({ order: index + 1, code, description }))
  });
}

module.exports = {
  SUPABASE_REGIONS,
  OWNERSHIP_MODES,
  MIGRATION_MODES,
  DATA_PLANE_MODES,
  MODULES,
  validateManifest,
  buildProvisioningPlan
};
