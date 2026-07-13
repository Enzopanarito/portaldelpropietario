'use strict';

const crypto = require('crypto');

const PREVIEW_CONTEXTS = new Set(['deploy-preview', 'branch-deploy', 'dev']);
const VALID_DATA_ENVIRONMENTS = new Set(['production', 'staging', 'test']);

function clean(value) { return String(value || '').trim(); }
function deployContext(env = process.env) { return clean(env.CONTEXT || env.DEPLOY_CONTEXT || 'production').toLowerCase(); }
function dataEnvironment(env = process.env) { return clean(env.VLA_DATA_ENVIRONMENT || '').toLowerCase(); }
function fingerprint(value) { return value ? crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12) : ''; }

function evaluateDataEnvironment(env = process.env) {
  const context = deployContext(env);
  const dataEnv = dataEnvironment(env);
  const activeBaseId = clean(env.AIRTABLE_BASE_ID);
  const productionBaseId = clean(env.AIRTABLE_PRODUCTION_BASE_ID);
  const stagingBaseId = clean(env.AIRTABLE_STAGING_BASE_ID);
  const errors = [];
  const warnings = [];

  if (!activeBaseId) errors.push('AIRTABLE_BASE_ID no está configurado.');
  if (dataEnv && !VALID_DATA_ENVIRONMENTS.has(dataEnv)) errors.push('VLA_DATA_ENVIRONMENT no tiene un valor permitido.');

  if (context === 'production') {
    if (dataEnv && dataEnv !== 'production') errors.push('Producción no puede usar un entorno de datos distinto de production.');
    if (productionBaseId && activeBaseId && activeBaseId !== productionBaseId) errors.push('Producción no apunta al AIRTABLE_PRODUCTION_BASE_ID declarado.');
    if (!productionBaseId) warnings.push('Defina AIRTABLE_PRODUCTION_BASE_ID para habilitar la verificación cruzada de producción.');
  } else if (PREVIEW_CONTEXTS.has(context)) {
    if (dataEnv !== 'staging' && dataEnv !== 'test') errors.push('Los deploy previews y entornos de desarrollo deben usar VLA_DATA_ENVIRONMENT=staging o test.');
    if (!productionBaseId) errors.push('AIRTABLE_PRODUCTION_BASE_ID es obligatorio fuera de producción para impedir conexiones accidentales.');
    if (activeBaseId && productionBaseId && activeBaseId === productionBaseId) errors.push('Un deploy preview no puede usar la base Airtable de producción.');
    if (dataEnv === 'staging' && stagingBaseId && activeBaseId !== stagingBaseId) errors.push('El entorno staging no apunta al AIRTABLE_STAGING_BASE_ID declarado.');
    if (dataEnv === 'staging' && !stagingBaseId) warnings.push('Defina AIRTABLE_STAGING_BASE_ID para verificar explícitamente el destino de staging.');
  } else {
    warnings.push(`Contexto Netlify no reconocido: ${context}.`);
  }

  return {
    ok: errors.length === 0,
    context,
    dataEnvironment: dataEnv || (context === 'production' ? 'production-legacy' : 'unset'),
    activeBaseFingerprint: fingerprint(activeBaseId),
    productionBaseFingerprint: fingerprint(productionBaseId),
    stagingBaseFingerprint: fingerprint(stagingBaseId),
    errors,
    warnings
  };
}

function assertSafeDataEnvironment(env = process.env) {
  const result = evaluateDataEnvironment(env);
  if (!result.ok) {
    const error = new Error(`Configuración de datos insegura: ${result.errors.join(' | ')}`);
    error.code = 'UNSAFE_DATA_ENVIRONMENT';
    error.details = result;
    throw error;
  }
  return result;
}

function assertStagingTarget({ sourceBaseId, targetBaseId, confirmation = '', apply = false } = {}) {
  const source = clean(sourceBaseId);
  const target = clean(targetBaseId);
  const errors = [];
  if (!/^app[A-Za-z0-9]{14}$/.test(source)) errors.push('AIRTABLE_PRODUCTION_BASE_ID inválido.');
  if (!/^app[A-Za-z0-9]{14}$/.test(target)) errors.push('AIRTABLE_STAGING_BASE_ID inválido.');
  if (source && target && source === target) errors.push('La base de origen y la base de staging no pueden ser la misma.');
  if (apply && confirmation !== 'REPLACE_STAGING_ONLY') errors.push('La escritura requiere STAGING_SYNC_CONFIRM=REPLACE_STAGING_ONLY.');
  if (errors.length) {
    const error = new Error(errors.join(' | '));
    error.code = 'UNSAFE_STAGING_TARGET';
    throw error;
  }
  return { sourceBaseId: source, targetBaseId: target, apply: Boolean(apply) };
}

module.exports = {
  PREVIEW_CONTEXTS,
  VALID_DATA_ENVIRONMENTS,
  deployContext,
  dataEnvironment,
  evaluateDataEnvironment,
  assertSafeDataEnvironment,
  assertStagingTarget,
  fingerprint
};
