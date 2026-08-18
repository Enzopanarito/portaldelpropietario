'use strict';

const base = require('./_balance_engine');
const {
  TOLERANCE,
  money,
  selectName,
  fieldsOf,
  paymentEquivalentUsd,
  isAppliedPayment,
  caracasClock
} = base;

function recordId(record) {
  return String(record && record.id || '');
}

function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean)
    : [];
}

function paymentOwnerIds(payment) {
  return linkedIds(fieldsOf(payment)['Propietario que Paga']);
}

function paymentDate(payment) {
  const raw = String(fieldsOf(payment)['Fecha de Pago'] || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function paymentMode(payment) {
  const raw = selectName(fieldsOf(payment)['Forma de Pago']).trim();
  if (raw === 'USD') return 'USD';
  if (raw === 'Bs BCV') return 'Bs BCV';
  return 'LEGACY';
}

function isGasoilExpense(expense) {
  return /\bgasoil\b/i.test(String(fieldsOf(expense).Concepto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

function reconciledPrior(owner) {
  const fields = fieldsOf(owner);
  const legacy = money(fields['Deuda Anterior']);
  let usd = money(fields['Deuda Anterior USD']);
  let bsRef = money(fields['Deuda Anterior Bs Ref']);
  const hasSplit = Math.abs(usd) > 0.001 || Math.abs(bsRef) > 0.001;
  if (!hasSplit) {
    bsRef = legacy;
  } else {
    const residual = money(legacy - money(usd + bsRef));
    if (Math.abs(residual) > TOLERANCE) bsRef = money(bsRef + residual);
  }
  return { usd, bsRef, totalRef: money(usd + bsRef), legacy };
}

function calculateCharges(owner, expenses) {
  const ownerId = recordId(owner);
  const aliquot = Number(fieldsOf(owner).Alicuota || 0);
  const commonRaw = { USD: 0, 'Bs BCV': 0 };
  const commonLines = { USD: [], 'Bs BCV': [] };
  const specialLines = { USD: [], 'Bs BCV': [] };

  for (const expense of expenses || []) {
    const fields = fieldsOf(expense);
    const type = selectName(fields['Tipo de Gasto']);
    const mode = selectName(fields['Forma de Pago']) === 'USD' ? 'USD' : 'Bs BCV';
    const owners = linkedIds(fields.Propietarios);
    const concept = String(fields.Concepto || 'Gasto');
    const amount = Number(fields.Monto || 0);
    const promptPaymentExcluded = isGasoilExpense(expense);

    if (type === 'Gasto Común') {
      if (owners.length && !owners.includes(ownerId)) continue;
      const raw = amount * aliquot;
      commonRaw[mode] += raw;
      commonLines[mode].push({ id: recordId(expense), concept, raw, amount: money(raw), mode, promptPaymentExcluded });
    } else if (type === 'Gasto Especial' && owners.includes(ownerId)) {
      const share = money(amount / Math.max(1, owners.length));
      specialLines[mode].push({ id: recordId(expense), concept, amount: share, mode, promptPaymentExcluded });
    }
  }

  function finalize(mode) {
    const targetCommon = money(commonRaw[mode]);
    const lines = commonLines[mode].map(line => ({ ...line, amount: money(line.amount) }));
    const roundedSum = money(lines.reduce((sum, line) => sum + line.amount, 0));
    const adjustment = money(targetCommon - roundedSum);
    if (lines.length && Math.abs(adjustment) > 0) {
      lines[lines.length - 1].amount = money(lines[lines.length - 1].amount + adjustment);
    }
    const specials = specialLines[mode];
    const all = [...lines.map(({ raw, ...line }) => line), ...specials];
    return {
      amount: money(targetCommon + specials.reduce((sum, line) => sum + line.amount, 0)),
      promptPaymentEligibleAmount: money(all.filter(line => !line.promptPaymentExcluded).reduce((sum, line) => sum + line.amount, 0)),
      promptPaymentExcludedAmount: money(all.filter(line => line.promptPaymentExcluded).reduce((sum, line) => sum + line.amount, 0)),
      lines: all
    };
  }

  const usd = finalize('USD');
  const bs = finalize('Bs BCV');
  return {
    usd: usd.amount,
    bsRef: bs.amount,
    promptPaymentEligibleBsRef: bs.promptPaymentEligibleAmount,
    promptPaymentExcludedBsRef: bs.promptPaymentExcludedAmount,
    expenseLinesUsd: usd.lines,
    expenseLinesBs: bs.lines
  };
}

function take(bucket, amount) {
  const used = Math.min(Math.max(0, bucket.value), Math.max(0, amount));
  bucket.value = money(bucket.value - used);
  return money(amount - used);
}

function calculateOwnerBalance(owner, expenses = [], payments = [], options = {}) {
  const ownerId = recordId(owner);
  const clock = options.month
    ? { month: String(options.month), day: Number(options.day || 31) }
    : caracasClock(options.now || new Date());
  const dueDay = Math.max(1, Math.min(28, Number(options.dueDay || 10)));
  const surchargeRate = Math.max(0, Math.min(1, Number(options.surchargeRate ?? 0.10)));
  const cutoff = `${clock.month}-${String(dueDay).padStart(2, '0')}`;
  const prior = reconciledPrior(owner);
  const charges = calculateCharges(owner, expenses);

  const state = {
    priorUsd: { value: Math.max(0, prior.usd) },
    priorBs: { value: Math.max(0, prior.bsRef) },
    currentUsd: { value: Math.max(0, charges.usd) },
    currentBsEligible: { value: Math.max(0, charges.promptPaymentEligibleBsRef) },
    currentBsExcluded: { value: Math.max(0, charges.promptPaymentExcludedBsRef) },
    creditUsd: Math.max(0, -prior.usd),
    creditBs: Math.max(0, -prior.bsRef)
  };

  let credit = state.creditUsd;
  credit = take(state.currentUsd, credit);
  state.creditUsd = credit;
  credit = state.creditBs;
  credit = take(state.currentBsEligible, credit);
  credit = take(state.currentBsExcluded, credit);
  state.creditBs = credit;

  const promptPaymentRequiredBsRef = money(state.currentBsEligible.value);
  const activePayments = (payments || [])
    .filter(payment => !isAppliedPayment(payment) && paymentOwnerIds(payment).includes(ownerId))
    .sort((a, b) => {
      const da = paymentDate(a) || '9999-99-99';
      const db = paymentDate(b) || '9999-99-99';
      return da.localeCompare(db) || recordId(a).localeCompare(recordId(b));
    });

  let paidUsd = 0;
  let paidBsRef = 0;
  let paidLegacyRef = 0;

  function applyPayment(payment) {
    const mode = paymentMode(payment);
    const original = paymentEquivalentUsd(payment);
    let remaining = original;
    if (mode === 'USD') {
      paidUsd = money(paidUsd + original);
      remaining = take(state.priorUsd, remaining);
      remaining = take(state.currentUsd, remaining);
      state.creditUsd = money(state.creditUsd + remaining);
    } else if (mode === 'Bs BCV') {
      paidBsRef = money(paidBsRef + original);
      remaining = take(state.priorBs, remaining);
      remaining = take(state.currentBsEligible, remaining);
      remaining = take(state.currentBsExcluded, remaining);
      state.creditBs = money(state.creditBs + remaining);
    } else {
      paidLegacyRef = money(paidLegacyRef + original);
      remaining = take(state.priorBs, remaining);
      remaining = take(state.priorUsd, remaining);
      remaining = take(state.currentBsEligible, remaining);
      remaining = take(state.currentBsExcluded, remaining);
      remaining = take(state.currentUsd, remaining);
      state.creditBs = money(state.creditBs + remaining);
    }
  }

  const timely = [];
  const late = [];
  for (const payment of activePayments) {
    const date = paymentDate(payment);
    if (date && date <= cutoff) timely.push(payment);
    else late.push(payment);
  }
  for (const payment of timely) applyPayment(payment);

  const currentEligibleAfterTimely = money(state.currentBsEligible.value);
  const timelyPaidBsRef = money(Math.max(0, promptPaymentRequiredBsRef - currentEligibleAfterTimely));
  const promptPaymentComplied = currentEligibleAfterTimely <= TOLERANCE;
  const recargoBsRef = clock.day > dueDay && charges.promptPaymentEligibleBsRef > TOLERANCE && !promptPaymentComplied
    ? money(charges.promptPaymentEligibleBsRef * surchargeRate)
    : 0;
  state.currentBsEligible.value = money(state.currentBsEligible.value + recargoBsRef);

  for (const payment of late) applyPayment(payment);

  const expiredUsd = money(state.priorUsd.value);
  const expiredBsRef = money(state.priorBs.value);
  const currentUsd = money(state.currentUsd.value - state.creditUsd);
  const currentBsRef = money(state.currentBsEligible.value + state.currentBsExcluded.value - state.creditBs);
  const usd = money(expiredUsd + currentUsd);
  const bsRef = money(expiredBsRef + currentBsRef);

  return {
    ownerId,
    month: clock.month,
    day: clock.day,
    priorUsd: prior.usd,
    priorBsRef: prior.bsRef,
    priorLegacyTotal: prior.legacy,
    chargesUsd: charges.usd,
    chargesBsRef: charges.bsRef,
    promptPaymentEligibleBsRef: charges.promptPaymentEligibleBsRef,
    promptPaymentExcludedBsRef: charges.promptPaymentExcludedBsRef,
    recargoBsRef,
    paidUsd,
    paidBsRef,
    paidLegacyRef,
    timelyPaidBsRef,
    promptPaymentRequiredBsRef,
    promptPaymentComplied,
    dueDay,
    surchargeRate,
    usd,
    bsRef,
    totalRef: money(usd + bsRef),
    expiredUsd,
    expiredBsRef,
    expiredTotalRef: money(expiredUsd + expiredBsRef),
    currentUsd,
    currentBsRef,
    currentTotalRef: money(currentUsd + currentBsRef),
    activePayments,
    expenseLinesUsd: charges.expenseLinesUsd,
    expenseLinesBs: charges.expenseLinesBs
  };
}

function calculateAllOwners(owners = [], expenses = [], payments = [], options = {}) {
  const byId = new Map();
  for (const owner of owners || []) byId.set(recordId(owner), calculateOwnerBalance(owner, expenses, payments, options));
  return byId;
}

module.exports = Object.assign({}, base, {
  isGasoilExpense,
  calculateOwnerBalance,
  calculateAllOwners
});
