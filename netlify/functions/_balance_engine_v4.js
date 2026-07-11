'use strict';

const base = require('./_balance_engine');
const { money, fieldsOf, selectName, calculatedFields } = base;

function linkedIds(value) {
  return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean) : [];
}

function calculateOwnerBalance(owner, expenses = [], payments = [], options = {}) {
  const result = base.calculateOwnerBalance(owner, expenses, payments, options);
  const ownerFields = fieldsOf(owner);
  const ownerId = String(owner && owner.id || '');
  const aliquot = Number(ownerFields.Alicuota || 0);
  let commonUsdTotal = 0, commonBsTotal = 0;
  let roundedUsdTotal = 0, roundedBsTotal = 0;

  for (const expense of expenses || []) {
    const f = fieldsOf(expense);
    if (selectName(f['Tipo de Gasto']) !== 'Gasto Común') continue;
    const linked = linkedIds(f.Propietarios);
    if (linked.length && !linked.includes(ownerId)) continue;
    const rawShare = Number(f.Monto || 0) * aliquot;
    const roundedShare = money(rawShare);
    if (selectName(f['Forma de Pago']) === 'USD') {
      commonUsdTotal += rawShare;
      roundedUsdTotal += roundedShare;
    } else {
      commonBsTotal += rawShare;
      roundedBsTotal += roundedShare;
    }
  }

  const correctedChargesUsd = money(result.chargesUsd + money(commonUsdTotal) - money(roundedUsdTotal));
  const correctedChargesBs = money(result.chargesBsRef + money(commonBsTotal) - money(roundedBsTotal));
  const promptRequired = money(Math.max(0, result.priorBsRef + correctedChargesBs));
  const promptComplied = result.timelyPaidBsRef + base.TOLERANCE >= promptRequired;
  const recargo = result.day > 10 && correctedChargesBs > base.TOLERANCE && !promptComplied ? money(correctedChargesBs * 0.10) : 0;
  const usd = money(result.priorUsd + correctedChargesUsd - result.paidUsd);
  const bsRef = money(result.priorBsRef + correctedChargesBs + recargo - result.paidBsRef);
  const positivePriorUsd = Math.max(0, result.priorUsd);
  const positivePriorBs = Math.max(0, result.priorBsRef);
  const remainingUsd = money(Math.max(0, result.paidUsd - positivePriorUsd));
  const remainingBs = money(Math.max(0, result.paidBsRef - positivePriorBs));

  return Object.assign({}, result, {
    chargesUsd: correctedChargesUsd,
    chargesBsRef: correctedChargesBs,
    promptPaymentRequiredBsRef: promptRequired,
    promptPaymentComplied: promptComplied,
    recargoBsRef: recargo,
    usd,
    bsRef,
    totalRef: money(usd + bsRef),
    currentUsd: money(correctedChargesUsd - remainingUsd),
    currentBsRef: money(correctedChargesBs + recargo - remainingBs),
    currentTotalRef: money(correctedChargesUsd - remainingUsd + correctedChargesBs + recargo - remainingBs)
  });
}

function calculateAllOwners(owners = [], expenses = [], payments = [], options = {}) {
  const byId = new Map();
  for (const owner of owners || []) byId.set(String(owner && owner.id || ''), calculateOwnerBalance(owner, expenses, payments, options));
  return byId;
}

module.exports = Object.assign({}, base, { calculateOwnerBalance, calculateAllOwners, calculatedFields });
