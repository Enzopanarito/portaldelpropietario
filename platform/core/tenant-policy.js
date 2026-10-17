'use strict';

const { validateCountryPack } = require('./country-pack');

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function object(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, message);
  return value;
}

function string(value, code, message) {
  const normalized = String(value ?? '').trim();
  if (!normalized) fail(code, message);
  return normalized;
}

function legalApprovalComplete(approval) {
  return Boolean(
    approval &&
    approval.approved === true &&
    String(approval.reference || '').trim() &&
    String(approval.reviewedBy || '').trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(approval.reviewDate || ''))
  );
}

function countryLegalReviewComplete(countryPack) {
  const legal = countryPack?.legalValidation;
  return Boolean(
    legal &&
    String(legal.reviewedBy || '').trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(legal.reviewDate || ''))
  );
}

function validateTenantPolicy(policy, countryPack) {
  validateCountryPack(countryPack);
  object(policy, 'TENANT_POLICY_INVALID', 'Tenant policy must be an object');

  const countryCode = string(policy.countryCode, 'TENANT_POLICY_COUNTRY_REQUIRED', 'countryCode is required').toUpperCase();
  if (countryCode !== countryPack.countryCode) {
    fail('TENANT_POLICY_COUNTRY_MISMATCH', `Tenant policy ${countryCode} does not match Country Pack ${countryPack.countryCode}`);
  }

  const timezone = string(policy.timezone, 'TENANT_POLICY_TIMEZONE_REQUIRED', 'timezone is required');
  const allowedTimezones = countryPack.locale.allowedTimezones || [countryPack.locale.defaultTimezone];
  if (!allowedTimezones.includes(timezone)) {
    fail('TENANT_POLICY_TIMEZONE_NOT_ALLOWED', `Timezone ${timezone} is not allowed by the Country Pack`);
  }

  const currencies = Array.isArray(policy.currencies) ? [...new Set(policy.currencies.map(x => String(x).trim().toUpperCase()))] : [];
  if (!currencies.length) fail('TENANT_POLICY_CURRENCY_REQUIRED', 'At least one currency is required');
  for (const currency of currencies) {
    if (!countryPack.currency.allowed.includes(currency)) {
      fail('TENANT_POLICY_CURRENCY_NOT_ALLOWED', `Currency ${currency} is not allowed by the Country Pack`);
    }
  }

  const payments = object(policy.payments || {}, 'TENANT_POLICY_PAYMENTS_INVALID', 'payments must be an object');
  const enabledRails = Array.isArray(payments.enabledRails) ? [...new Set(payments.enabledRails.map(String))] : [];
  const supportedRails = new Set((countryPack.payments.supportedRails || []).map(rail => String(rail.code)));
  for (const rail of enabledRails) {
    if (!supportedRails.has(rail)) fail('TENANT_POLICY_PAYMENT_RAIL_NOT_ALLOWED', `Payment rail ${rail} is not supported by the Country Pack`);
  }

  const access = object(policy.access || {}, 'TENANT_POLICY_ACCESS_INVALID', 'access must be an object');
  const provider = string(access.provider, 'TENANT_POLICY_ACCESS_PROVIDER_REQUIRED', 'access.provider is required');
  if (!countryPack.access.allowedProviderKinds.includes(provider)) {
    fail('TENANT_POLICY_ACCESS_PROVIDER_NOT_ALLOWED', `Access provider ${provider} is not allowed by the Country Pack`);
  }
  if (countryPack.access.emergencyFailSafeRequired === true && access.emergencyFailSafe !== true) {
    fail('TENANT_POLICY_FAIL_SAFE_REQUIRED', 'Emergency fail-safe is mandatory for this Country Pack');
  }

  const debtRestriction = object(access.debtRestriction || { enabled: false }, 'TENANT_POLICY_DEBT_RESTRICTION_INVALID', 'access.debtRestriction must be an object');
  const debtRestrictionEnabled = debtRestriction.enabled === true;
  const countryMode = countryPack.collections.physicalAccessRestrictionByDebt;

  if (debtRestrictionEnabled) {
    if (countryMode === 'disabled') {
      fail('ACCESS_DEBT_RESTRICTION_DISABLED', 'Debt-based physical access restriction is disabled by the Country Pack');
    }
    if (countryMode === 'legal-review-required') {
      if (!countryLegalReviewComplete(countryPack)) {
        fail('ACCESS_DEBT_COUNTRY_REVIEW_REQUIRED', 'The Country Pack has not completed legal review for debt-based physical access restriction');
      }
      if (!legalApprovalComplete(debtRestriction.legalApproval)) {
        fail('ACCESS_DEBT_TENANT_REVIEW_REQUIRED', 'Tenant legal approval is required before debt-based physical access restriction can be enabled');
      }
    }
    if (countryMode === 'conditionally-allowed' && !legalApprovalComplete(debtRestriction.legalApproval)) {
      fail('ACCESS_DEBT_TENANT_REVIEW_REQUIRED', 'Tenant legal approval is required for this conditional access policy');
    }
  }

  return Object.freeze({
    countryCode,
    timezone,
    currencies: Object.freeze(currencies),
    payments: Object.freeze({ enabledRails: Object.freeze(enabledRails) }),
    access: Object.freeze({
      provider,
      emergencyFailSafe: access.emergencyFailSafe === true,
      debtRestriction: Object.freeze({
        enabled: debtRestrictionEnabled,
        legalApproval: debtRestriction.legalApproval || null
      })
    })
  });
}

module.exports = {
  validateTenantPolicy,
  legalApprovalComplete,
  countryLegalReviewComplete
};
