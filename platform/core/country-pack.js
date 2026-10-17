'use strict';

const fs = require('node:fs');

const STATUS = new Set(['draft', 'legal-review', 'pilot', 'supported', 'deprecated']);
const ACCESS_DEBT_MODES = new Set(['disabled', 'legal-review-required', 'conditionally-allowed']);

function invariant(condition, message, code = 'COUNTRY_PACK_INVALID') {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function validateCountryPack(pack) {
  invariant(isPlainObject(pack), 'Country Pack must be an object');
  invariant(pack.schemaVersion === '1.0', 'Unsupported Country Pack schemaVersion');
  invariant(/^[A-Z]{2}$/.test(String(pack.countryCode || '')), 'countryCode must be ISO alpha-2 uppercase');
  invariant(/^\d+\.\d+\.\d+$/.test(String(pack.version || '')), 'version must be semver-like x.y.z');
  invariant(STATUS.has(pack.status), 'Invalid Country Pack status');

  invariant(isPlainObject(pack.locale), 'locale is required');
  invariant(Boolean(pack.locale.defaultLanguage), 'locale.defaultLanguage is required');
  invariant(Array.isArray(pack.locale.supportedLanguages) && pack.locale.supportedLanguages.length > 0, 'locale.supportedLanguages is required');
  invariant(pack.locale.supportedLanguages.includes(pack.locale.defaultLanguage), 'defaultLanguage must be included in supportedLanguages');
  invariant(Boolean(pack.locale.defaultTimezone), 'locale.defaultTimezone is required');

  invariant(isPlainObject(pack.currency), 'currency is required');
  invariant(/^[A-Z]{3}$/.test(String(pack.currency.primary || '')), 'currency.primary must be ISO 4217 style');
  invariant(Array.isArray(pack.currency.allowed) && pack.currency.allowed.includes(pack.currency.primary), 'currency.allowed must include currency.primary');

  invariant(isPlainObject(pack.privacy), 'privacy is required');
  invariant(pack.privacy.legalReviewRequired === true, 'Country Packs must require legal review');
  invariant(Boolean(pack.privacy.defaultRetentionPolicy), 'privacy.defaultRetentionPolicy is required');

  invariant(isPlainObject(pack.collections), 'collections is required');
  invariant(ACCESS_DEBT_MODES.has(pack.collections.physicalAccessRestrictionByDebt), 'Invalid physicalAccessRestrictionByDebt mode');

  invariant(isPlainObject(pack.access), 'access is required');
  invariant(pack.access.storeBiometricTemplatesInCore === false, 'Core must not store raw biometric templates');
  invariant(Array.isArray(pack.access.allowedProviderKinds), 'access.allowedProviderKinds is required');

  invariant(isPlainObject(pack.payments) && Array.isArray(pack.payments.supportedRails), 'payments.supportedRails is required');
  invariant(isPlainObject(pack.documents), 'documents is required');
  invariant(isPlainObject(pack.terminology), 'terminology is required');

  return true;
}

function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  invariant(/^[A-Z]{2}$/.test(code), 'Invalid country code', 'COUNTRY_CODE_INVALID');
  return code;
}

function loadCountryPack(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validateCountryPack(parsed);
  return deepFreeze(parsed);
}

function loadCountryPackObject(input) {
  const copy = structuredClone(input);
  validateCountryPack(copy);
  return deepFreeze(copy);
}

module.exports = {
  STATUS,
  ACCESS_DEBT_MODES,
  normalizeCountryCode,
  validateCountryPack,
  loadCountryPack,
  loadCountryPackObject
};
