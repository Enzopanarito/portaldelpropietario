'use strict';

function required(env, key) {
  const value = String(env?.[key] || '').trim();
  if (!value) throw Object.assign(new Error(`Missing ${key}`), { code: 'RUNTIME_CONFIG_MISSING', key });
  return value;
}

function optional(env, key) {
  const value = String(env?.[key] || '').trim();
  return value || null;
}

function normalizeUrl(value, key) {
  let url;
  try { url = new URL(value); } catch (_) {
    throw Object.assign(new Error(`Invalid ${key}`), { code: 'RUNTIME_CONFIG_INVALID_URL', key });
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw Object.assign(new Error(`${key} must use HTTPS`), { code: 'RUNTIME_CONFIG_INSECURE_URL', key });
  }
  return url.toString().replace(/\/$/, '');
}

function readRuntimeConfig(env = process.env) {
  const countryCode = required(env, 'SAAS_COUNTRY_CODE').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw Object.assign(new Error('SAAS_COUNTRY_CODE must be ISO alpha-2'), { code: 'RUNTIME_CONFIG_COUNTRY_INVALID' });
  }

  return Object.freeze({
    deploymentId: required(env, 'SAAS_DEPLOYMENT_ID'),
    countryCode,
    supabaseUrl: normalizeUrl(required(env, 'SUPABASE_URL'), 'SUPABASE_URL'),
    supabasePublishableKey: required(env, 'SUPABASE_PUBLISHABLE_KEY'),
    supabaseSecretKey: optional(env, 'SUPABASE_SECRET_KEY'),
    countryPackPath: optional(env, 'SAAS_COUNTRY_PACK_PATH')
  });
}

function publicRuntimeConfig(config) {
  if (!config) throw new Error('Runtime config is required');
  return Object.freeze({
    deploymentId: config.deploymentId,
    countryCode: config.countryCode,
    supabaseUrl: config.supabaseUrl,
    supabasePublishableKey: config.supabasePublishableKey
  });
}

module.exports = { readRuntimeConfig, publicRuntimeConfig };
