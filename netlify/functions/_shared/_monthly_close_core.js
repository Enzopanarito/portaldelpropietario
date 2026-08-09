'use strict';

const crypto = require('crypto');

const TOLERANCE = 0.01;

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function selectName(value) {
  return value && typeof value === 'object' && value.name ? value.name : String(value || '');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function isAppliedPayment(record) {
  return record?.fields?.['[x] Aplicado al Cierre'] === true;
}

function hasLegacyIndividualCharges(expenses) {
  return (expenses || []).some(record => String(record?.fields?.Concepto || '').toLowerCase().includes('(cargo individual)'));
}

function ownerShare(expense, owner) {
  const fields = expense?.fields || {};
  const amount = Number(fields.Monto || 0);
  const type = selectName(fields['Tipo de Gasto']);
  const linkedOwners = Array.isArray(fields.Propietarios) ? fields.Propietarios : [];
  const aliquot = Number(owner?.fields?.Alicuota || 0);
  if (type === 'Gasto Común') return money(amount * aliquot);
  if (type === 'Gasto Especial' && linkedOwners.includes(owner.id)) return money(amount / (linkedOwners.length || 1));
  return 0;
}

function paymentEquivalentUsd(payment) {
  const fields = payment?.fields || {};
  return money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0);
}

function explicitNegativeSplit(total, initialUsd, initialBs, rawUsd, rawBsRef) {
  if (total >= -TOLERANCE) return { usd: 0, bsRef: 0 };
  if (initialUsd < -TOLERANCE && Math.abs(initialBs) <= TOLERANCE) return { usd: total, bsRef: 0 };
  if (initialBs < -TOLERANCE && Math.abs(initialUsd) <= TOLERANCE) return { usd: 0, bsRef: total };
  const negativeUsd = Math.max(0, -rawUsd);
  const negativeBs = Math.max(0, -rawBsRef);
  const negativeTotal = negativeUsd + negativeBs;
  if (negativeTotal <= TOLERANCE) return { usd: 0, bsRef: total };
  if (negativeUsd > TOLERANCE && negativeBs <= TOLERANCE) return { usd: total, bsRef: 0 };
  if (negativeBs > TOLERANCE && negativeUsd <= TOLERANCE) return { usd: 0, bsRef: total };
  const usd = money(total * (negativeUsd / negativeTotal));
  return { usd, bsRef: money(total - usd) };
}

function calculateSplitBalance(owner, expenses, payments, transitionMode) {
  const fields = owner?.fields || {};
  const initialUsd = Number(fields['Deuda Anterior USD'] || 0);
  const initialBs = Number(fields['Deuda Anterior Bs Ref'] || 0);
  const splitExists = Math.abs(initialUsd) > 0.001 || Math.abs(initialBs) > 0.001;
  let usdBalance = initialUsd;
  let bsRefBalance = initialBs;
  if (!splitExists) bsRefBalance += Number(fields['Deuda Anterior'] || 0);

  for (const expense of expenses || []) {
    const share = ownerShare(expense, owner);
    if (share <= 0) continue;
    const mode = selectName(expense?.fields?.['Forma de Pago'] || 'Bs BCV');
    if (mode === 'USD') usdBalance += share;
    else bsRefBalance += share;
  }

  for (const payment of payments || []) {
    if (isAppliedPayment(payment)) continue;
    const linkedOwners = payment?.fields?.['Propietario que Paga'] || [];
    if (!Array.isArray(linkedOwners) || !linkedOwners.includes(owner.id)) continue;
    const mode = selectName(payment?.fields?.['Forma de Pago'] || 'Bs BCV');
    const amount = paymentEquivalentUsd(payment);
    if (mode === 'USD') usdBalance -= amount;
    else bsRefBalance -= amount;
  }

  const rawUsd = money(usdBalance);
  const rawBsRef = money(bsRefBalance);
  const rawTotal = money(rawUsd + rawBsRef);
  const legacyTotal = money(fields['Deuda Restante']);
  let finalUsd = rawUsd;
  let finalBsRef = rawBsRef;
  let totalRef = rawTotal;
  let reconciled = false;
  const difference = money(rawTotal - legacyTotal);

  if (transitionMode && Number.isFinite(legacyTotal)) {
    reconciled = true;
    totalRef = legacyTotal;
    if (legacyTotal <= TOLERANCE) {
      const negative = explicitNegativeSplit(legacyTotal, initialUsd, initialBs, rawUsd, rawBsRef);
      finalUsd = negative.usd;
      finalBsRef = negative.bsRef;
    } else {
      const positiveUsd = Math.max(0, rawUsd);
      const positiveBs = Math.max(0, rawBsRef);
      const positiveTotal = positiveUsd + positiveBs;
      if (positiveTotal <= TOLERANCE) {
        finalUsd = 0;
        finalBsRef = legacyTotal;
      } else {
        finalUsd = money(legacyTotal * (positiveUsd / positiveTotal));
        finalBsRef = money(legacyTotal - finalUsd);
      }
    }
  }

  return {
    usd: money(finalUsd),
    bsRef: money(finalBsRef),
    totalRef: money(totalRef),
    rawUsd,
    rawBsRef,
    rawTotal,
    legacyTotal,
    difference,
    reconciled
  };
}

function ownerBefore(owner) {
  const fields = owner?.fields || {};
  return {
    deudaAnteriorUsd: money(fields['Deuda Anterior USD']),
    deudaAnteriorBsRef: money(fields['Deuda Anterior Bs Ref']),
    deudaAnterior: money(fields['Deuda Anterior'])
  };
}

function ownerTarget(balance) {
  return {
    deudaAnteriorUsd: money(balance.usd),
    deudaAnteriorBsRef: money(balance.bsRef),
    deudaAnterior: money(balance.totalRef)
  };
}

function compactOwnerSource(owner) {
  const fields = owner?.fields || {};
  return {
    id: owner.id,
    casa: fields.Casa ?? null,
    propietario: String(fields.Propietario || ''),
    alicuota: Number(fields.Alicuota || 0),
    deudaAnterior: money(fields['Deuda Anterior']),
    deudaAnteriorUsd: money(fields['Deuda Anterior USD']),
    deudaAnteriorBsRef: money(fields['Deuda Anterior Bs Ref']),
    deudaRestante: money(fields['Deuda Restante'])
  };
}

function compactExpenseSource(expense) {
  const fields = expense?.fields || {};
  return {
    id: expense.id,
    concepto: String(fields.Concepto || ''),
    monto: money(fields.Monto),
    tipo: selectName(fields['Tipo de Gasto']),
    forma: selectName(fields['Forma de Pago'] || 'Bs BCV'),
    propietarios: [...(Array.isArray(fields.Propietarios) ? fields.Propietarios : [])].sort()
  };
}

function compactPaymentSource(payment) {
  const fields = payment?.fields || {};
  return {
    id: payment.id,
    propietarios: [...(Array.isArray(fields['Propietario que Paga']) ? fields['Propietario que Paga'] : [])].sort(),
    montoPagado: money(fields['Monto Pagado']),
    montoPagadoBs: money(fields['Monto Pagado Bs']),
    tasaBcv: Number(fields['Tasa BCV Aplicada'] || 0),
    equivalenteUsd: money(fields['Equivalente USD Aplicado']),
    forma: selectName(fields['Forma de Pago'] || 'Bs BCV'),
    fecha: String(fields['Fecha de Pago'] || '').slice(0, 10),
    aplicado: fields['[x] Aplicado al Cierre'] === true
  };
}

function buildPlan({ owners = [], expenses = [], payments = [], month }) {
  const sortedOwners = [...owners].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sortedExpenses = [...expenses].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sortedPayments = [...payments].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const transitionMode = hasLegacyIndividualCharges(sortedExpenses);

  const ownerUpdates = sortedOwners.map(owner => {
    const balance = calculateSplitBalance(owner, sortedExpenses, sortedPayments, transitionMode);
    return {
      id: owner.id,
      casa: owner?.fields?.Casa ?? null,
      propietario: String(owner?.fields?.Propietario || ''),
      before: ownerBefore(owner),
      target: ownerTarget(balance),
      calculation: balance
    };
  });
  const paymentIds = sortedPayments.filter(payment => !isAppliedPayment(payment)).map(payment => payment.id);

  const totalUsd = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnteriorUsd, 0));
  const totalBsRef = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnteriorBsRef, 0));
  const totalRef = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnterior, 0));
  const rawTotal = money(ownerUpdates.reduce((sum, item) => sum + item.calculation.rawTotal, 0));
  const legacyTotal = money(ownerUpdates.reduce((sum, item) => sum + item.calculation.legacyTotal, 0));
  const differences = ownerUpdates
    .filter(item => Math.abs(item.calculation.difference) > TOLERANCE)
    .map(item => ({
      ownerId: item.id,
      casa: item.casa,
      propietario: item.propietario,
      rawTotal: item.calculation.rawTotal,
      legacyTotal: item.calculation.legacyTotal,
      difference: item.calculation.difference
    }));

  const validation = {
    month,
    transitionMode,
    totalUsd,
    totalBsRef,
    totalRef,
    rawTotal,
    legacyTotal,
    difference: money(rawTotal - legacyTotal),
    differences,
    differenceCount: differences.length,
    conDeudaUsd: ownerUpdates.filter(item => item.target.deudaAnteriorUsd > TOLERANCE).length,
    conDeudaBs: ownerUpdates.filter(item => item.target.deudaAnteriorBsRef > TOLERANCE).length,
    conSaldoFavor: ownerUpdates.filter(item => item.target.deudaAnterior < -TOLERANCE).length,
    pendingPaymentsCount: paymentIds.length,
    ownerCount: ownerUpdates.length
  };

  const source = {
    owners: sortedOwners.map(compactOwnerSource),
    expenses: sortedExpenses.map(compactExpenseSource),
    payments: sortedPayments.map(compactPaymentSource)
  };
  const sourceHash = hashJson(source);
  const planHash = hashJson({
    version: 3,
    month,
    sourceHash,
    ownerUpdates: ownerUpdates.map(item => ({ id: item.id, before: item.before, target: item.target })),
    paymentIds
  });

  return {
    version: 3,
    month,
    generatedAt: new Date().toISOString(),
    transitionMode,
    sourceHash,
    planHash,
    ownerUpdates,
    paymentIds,
    validation
  };
}

function debtFields(values) {
  return {
    'Deuda Anterior USD': money(values.deudaAnteriorUsd),
    'Deuda Anterior Bs Ref': money(values.deudaAnteriorBsRef),
    'Deuda Anterior': money(values.deudaAnterior)
  };
}

function currentDebtValues(owner) {
  return ownerBefore(owner);
}

function compareDebtValues(expected, actual, tolerance = TOLERANCE) {
  const differences = [];
  for (const field of ['deudaAnteriorUsd', 'deudaAnteriorBsRef', 'deudaAnterior']) {
    if (Math.abs(Number(expected[field] || 0) - Number(actual[field] || 0)) > tolerance) {
      differences.push({ field, expected: expected[field], actual: actual[field] });
    }
  }
  return { ok: differences.length === 0, differences };
}

function isBeforeOrTarget(current, item) {
  return compareDebtValues(item.before, current).ok || compareDebtValues(item.target, current).ok;
}

module.exports = {
  TOLERANCE,
  money,
  selectName,
  hashJson,
  isAppliedPayment,
  hasLegacyIndividualCharges,
  ownerShare,
  paymentEquivalentUsd,
  calculateSplitBalance,
  buildPlan,
  debtFields,
  currentDebtValues,
  compareDebtValues,
  isBeforeOrTarget
};
