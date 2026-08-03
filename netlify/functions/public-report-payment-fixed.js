'use strict';

const proofStorePath = require.resolve('./_payment_proof_store');
const compatibleProofStore = require('./_payment_proof_store_compat');

// El orquestador existente carga este módulo por nombre. Sustituimos únicamente
// su implementación de almacenamiento por una capa compatible con la API actual.
require.cache[proofStorePath].exports = compatibleProofStore;

module.exports = require('./public-report-payment');
