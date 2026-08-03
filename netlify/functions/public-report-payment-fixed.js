'use strict';

const proofStorePath = require.resolve('./_payment_proof_store');
const compatibleProofStore = require('./_payment_proof_store_compat');

// El orquestador existente carga este módulo por nombre. Sustituimos únicamente
// su implementación de almacenamiento por una capa compatible con la API actual.
require.cache[proofStorePath].exports = compatibleProofStore;

const original = require('./public-report-payment');

exports.handler = async function handler(event, context) {
  const response = await original.handler(event, context);
  if (!response || Number(response.statusCode || 0) < 400) return response;

  try {
    const body = JSON.parse(response.body || '{}');
    if (body.detail) body.message = body.detail;
    response.body = JSON.stringify(body);
  } catch (_) {}

  return response;
};
