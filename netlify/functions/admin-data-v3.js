'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');

const previous = require('./admin-data-v2');
const { calculateAllOwners, calculatedFields, money } = require('./_shared/_balance_engine_v4');
const { attachOfficialBalances, officialControlQuery } = require('./_shared/_official_balances');

const NO_STORE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'Surrogate-Control': 'no-store'
};

function controlUrl(baseId) {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent('ControlVersiones')}${officialControlQuery()}`;
}

async function loadOfficialControl() {
  const token = process.env.AIRTABLE_API_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const response = await fetch(controlUrl(baseId), {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || 'No se pudo leer el saldo oficial.');
  }
  return data.records || [];
}

function asOwnerRecord(owner) {
  const fields = { ...owner };
  delete fields.id;
  return { id: owner.id, fields };
}

function canonicalOwnerFields(balance) {
  if (!balance || ![balance.usd, balance.bsRef, balance.totalRef, balance.expiredUsd, balance.expiredBsRef, balance.currentUsd, balance.currentBsRef].every(Number.isFinite)) {
    const error = new Error('El contrato financiero canónico del administrador está incompleto.');
    error.code = 'FINANCIAL_CONTRACT_INCOMPLETE';
    throw error;
  }
  const saldoUsd=money(balance.usd),saldoBsRef=money(balance.bsRef);
  return {
    saldoUsd,
    saldoBsRef,
    totalPagadero:money(Math.max(0,saldoUsd)+Math.max(0,saldoBsRef)),
    saldoNetoReferencial:money(balance.totalRef),
    saldoFavorUsd:money(Math.max(0,-saldoUsd)),
    saldoFavorBs:money(Math.max(0,-saldoBsRef)),
    deudaVencidaUsd:money(Math.max(0,balance.expiredUsd)),
    deudaVencidaBs:money(Math.max(0,balance.expiredBsRef)),
    mesCorrienteUsd:money(balance.currentUsd),
    mesCorrienteBs:money(balance.currentBsRef),
    balanceEngineVersion:'vla-balance-contract-v7'
  };
}

function synchronizePayload(payload, controlRecords) {
  const rawOwners = (payload.propietarios || []).map(asOwnerRecord);
  const officialOwners = attachOfficialBalances(rawOwners, controlRecords);
  const balances = calculateAllOwners(officialOwners, payload.gastos || [], payload.pagos || []);
  const propietarios = officialOwners
    .map(record => Object.assign(
      { id: record.id },
      record.fields || {},
      calculatedFields(balances.get(record.id), record),
      canonicalOwnerFields(balances.get(record.id))
    ))
    .sort((left, right) => Number(left.Casa || 0) - Number(right.Casa || 0));
  return Object.assign({}, payload, {
    balanceEngineVersion: 5,
    officialBalanceSource: 'ControlVersiones',
    propietarios
  });
}

const handler = async function handler(event) {
  const response = await previous.handler(event);
  if (response.statusCode !== 200) return response;
  try {
    const payload = JSON.parse(response.body || '{}');
    const controlRecords = await loadOfficialControl();
    return {
      statusCode: 200,
      headers: Object.assign({}, NO_STORE_HEADERS, response.headers || {}, { 'X-Balance-Engine': '5' }),
      body: JSON.stringify(synchronizePayload(payload, controlRecords))
    };
  } catch (error) {
    return {
      statusCode: 503,
      headers: NO_STORE_HEADERS,
      body: JSON.stringify({
        message: 'No se pudo sincronizar el saldo oficial del portal administrativo.',
        detail: String(error.message || '').slice(0, 500)
      })
    };
  }
};

module.exports.synchronizePayload = synchronizePayload;
module.exports.canonicalOwnerFields = canonicalOwnerFields;

exports.handler = withAirtableUsage('admin-data-v3', handler);
