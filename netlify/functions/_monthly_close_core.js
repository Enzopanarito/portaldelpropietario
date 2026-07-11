'use strict';

const crypto = require('crypto');
const balanceEngine = require('./_balance_engine_v4');
const { attachOfficialBalances } = require('./_official_balances');

const TOLERANCE = balanceEngine.TOLERANCE;
const money = balanceEngine.money;
const selectName = balanceEngine.selectName;
const isAppliedPayment = balanceEngine.isAppliedPayment;
const ownerShare = balanceEngine.ownerShare;
const paymentEquivalentUsd = balanceEngine.paymentEquivalentUsd;

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

function hasLegacyIndividualCharges(expenses) {
  return (expenses || []).some(record => String(record?.fields?.Concepto || '').toLowerCase().includes('(cargo individual)'));
}

function currentMonthCaracas(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function calculateSplitBalance(owner, expenses, payments, transitionMode = false, month = currentMonthCaracas()) {
  const fields = owner?.fields || {};
  const result = balanceEngine.calculateOwnerBalance(owner, expenses || [], payments || [], {
    month: String(month),
    day: 31
  });
  const usd = money(result.usd);
  const bsRef = money(result.bsRef);
  const totalRef = money(result.totalRef);
  const legacyTotal = money(fields['Deuda Restante']);

  return {
    usd,
    bsRef,
    totalRef,
    rawUsd: usd,
    rawBsRef: bsRef,
    rawTotal: totalRef,
    legacyTotal,
    difference: money(totalRef - legacyTotal),
    reconciled: result.officialSnapshotActive === true,
    officialSnapshotActive: result.officialSnapshotActive === true,
    recargoBsRef: money(result.recargoBsRef),
    chargesUsd: money(result.chargesUsd),
    chargesBsRef: money(result.chargesBsRef),
    paidUsd: money(result.paidUsd),
    paidBsRef: money(result.paidBsRef),
    transitionMode: transitionMode === true
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
    deudaRestante: money(fields['Deuda Restante']),
    mesSaldoOficial: String(fields['Mes Saldo Oficial'] || ''),
    saldoOficialUsdBase: money(fields['Saldo Oficial USD Base']),
    saldoOficialBsRefBase: money(fields['Saldo Oficial Bs Ref Base']),
    baseVigenteBsRef: money(fields['Base Recargo Oficial Bs Ref']),
    corteSaldoOficial: String(fields['Corte Saldo Oficial'] || '')
  };
}

function compactExpenseSource(expense) {
  const fields = expense?.fields || {};
  return {
    id: expense.id,
    concepto: String(fields.Concepto || ''),
    monto: money(fields.Monto),
    tipo: selectName(fields['Tipo de Gasto']),
    frecuencia: selectName(fields.Frecuencia),
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
    aplicado: fields['[x] Aplicado al Cierre'] === true,
    createdTime: String(payment?.createdTime || '')
  };
}

function buildPlan({ owners = [], expenses = [], payments = [], month }) {
  const normalizedMonth = String(month || currentMonthCaracas());
  const normalizedOwners = attachOfficialBalances(owners, [], normalizedMonth);
  const sortedOwners = [...normalizedOwners].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sortedExpenses = [...expenses].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sortedPayments = [...payments].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const transitionMode = hasLegacyIndividualCharges(sortedExpenses);

  const ownerUpdates = sortedOwners.map(owner => {
    const balance = calculateSplitBalance(owner, sortedExpenses, sortedPayments, transitionMode, normalizedMonth);
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
  const rawTotal = totalRef;
  const legacyTotal = money(ownerUpdates.reduce((sum, item) => sum + item.calculation.legacyTotal, 0));
  const totalVigenteBsRef = money(ownerUpdates.reduce((sum, item) => sum + item.calculation.recargoBsRef, 0));
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
    month: normalizedMonth,
    transitionMode,
    engine: 'unified-balance-v4',
    totalUsd,
    totalBsRef,
    totalRef,
    rawTotal,
    legacyTotal,
    difference: money(rawTotal - legacyTotal),
    differences,
    differenceCount: differences.length,
    totalVigenteBsRef,
    officialSnapshotCount: ownerUpdates.filter(item => item.calculation.officialSnapshotActive).length,
    conDeudaUsd: ownerUpdates.filter(item => item.target.deudaAnteriorUsd > TOLERANCE).length,
    conDeudaBs: ownerUpdates.filter(item => item.target.deudaAnteriorBsRef > TOLERANCE).length,
    conSaldoFavor: ownerUpdates.filter(item => item.target.deudaAnterior < -TOLERANCE).length,
    pendingPaymentsCount: paymentIds.length,
    ownerCount: ownerUpdates.length,
    expenseCount: sortedExpenses.length
  };

  const source = {
    owners: sortedOwners.map(compactOwnerSource),
    expenses: sortedExpenses.map(compactExpenseSource),
    payments: sortedPayments.map(compactPaymentSource)
  };
  const sourceHash = hashJson(source);
  const planHash = hashJson({
    version: 4,
    month: normalizedMonth,
    sourceHash,
    ownerUpdates: ownerUpdates.map(item => ({ id: item.id, before: item.before, target: item.target })),
    paymentIds
  });

  return {
    version: 4,
    month: normalizedMonth,
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
