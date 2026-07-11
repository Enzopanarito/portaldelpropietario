'use strict';

const TOLERANCE = 0.01;

function money(value) {
  const number = Number(value || 0);
  if (Math.abs(number) < 0.005) return 0;
  const scaled = number * 100;
  const rounded = scaled >= 0
    ? Math.floor(scaled + 0.5 + 1e-9)
    : Math.ceil(scaled - 0.5 - 1e-9);
  return rounded / 100;
}

function selectName(value) {
  if (value && typeof value === 'object' && value.name) return String(value.name);
  return String(value || '');
}

function fieldsOf(record) {
  return record && record.fields ? record.fields : (record || {});
}

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

function paymentEquivalentUsd(payment) {
  const fields = fieldsOf(payment);
  return money(fields['Equivalente USD Aplicado'] || fields['Monto Pagado'] || 0);
}

function isAppliedPayment(payment) {
  return fieldsOf(payment)['[x] Aplicado al Cierre'] === true;
}

function caracasClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { month: `${parts.year}-${parts.month}`, day: Number(parts.day || 1) };
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

function reconciledPrior(owner) {
  const fields = fieldsOf(owner);
  const legacy = money(fields['Deuda Anterior']);
  let usd = money(fields['Deuda Anterior USD']);
  let bsRef = money(fields['Deuda Anterior Bs Ref']);
  const hasSplit = Math.abs(usd) > 0.001 || Math.abs(bsRef) > 0.001;

  if (!hasSplit) {
    bsRef = legacy;
  } else {
    // Durante la migración algunas casas tienen un total histórico que no coincide con
    // la suma de los dos campos nuevos. El residuo se conserva en Bs para no perder deuda
    // ni saldo a favor; nunca se inventa ni se elimina valor histórico.
    const residual = money(legacy - money(usd + bsRef));
    if (Math.abs(residual) > TOLERANCE) bsRef = money(bsRef + residual);
  }
  return { usd, bsRef, totalRef: money(usd + bsRef), legacy };
}

function ownerShare(expense, owner) {
  const expenseFields = fieldsOf(expense);
  const ownerFields = fieldsOf(owner);
  const amount = Number(expenseFields.Monto || 0);
  const type = selectName(expenseFields['Tipo de Gasto']);
  const owners = linkedIds(expenseFields.Propietarios);
  const ownerId = recordId(owner);
  const aliquot = Number(ownerFields.Alicuota || 0);
  if (type === 'Gasto Común') {
    if (owners.length && !owners.includes(ownerId)) return 0;
    return money(amount * aliquot);
  }
  if (type === 'Gasto Especial' && owners.includes(ownerId)) {
    return money(amount / Math.max(1, owners.length));
  }
  return 0;
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

    if (type === 'Gasto Común') {
      if (owners.length && !owners.includes(ownerId)) continue;
      const raw = amount * aliquot;
      commonRaw[mode] += raw;
      commonLines[mode].push({ id: recordId(expense), concept, raw, amount: money(raw), mode });
    } else if (type === 'Gasto Especial' && owners.includes(ownerId)) {
      const share = money(amount / Math.max(1, owners.length));
      specialLines[mode].push({ id: recordId(expense), concept, amount: share, mode });
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
    return {
      amount: money(targetCommon + specials.reduce((sum, line) => sum + line.amount, 0)),
      lines: [...lines.map(({ raw, ...line }) => line), ...specials]
    };
  }

  const usd = finalize('USD');
  const bs = finalize('Bs BCV');
  return {
    usd: usd.amount,
    bsRef: bs.amount,
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
  const cutoff = `${clock.month}-10`;
  const prior = reconciledPrior(owner);
  const charges = calculateCharges(owner, expenses);

  const state = {
    priorUsd: { value: Math.max(0, prior.usd) },
    priorBs: { value: Math.max(0, prior.bsRef) },
    currentUsd: { value: Math.max(0, charges.usd) },
    currentBs: { value: Math.max(0, charges.bsRef) },
    creditUsd: Math.max(0, -prior.usd),
    creditBs: Math.max(0, -prior.bsRef)
  };

  // Los saldos a favor históricos sí reducen el mes corriente. Las deudas históricas
  // positivas permanecen separadas y jamás forman parte de la base del recargo.
  let credit = state.creditUsd;
  credit = take(state.currentUsd, credit);
  state.creditUsd = credit;
  credit = state.creditBs;
  credit = take(state.currentBs, credit);
  state.creditBs = credit;

  const promptPaymentRequiredBsRef = money(state.currentBs.value);
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
      remaining = take(state.currentBs, remaining);
      state.creditBs = money(state.creditBs + remaining);
    } else {
      paidLegacyRef = money(paidLegacyRef + original);
      // Los pagos históricos sin moneda se aplican en el orden administrativo que se
      // utilizaba antes de separar las cuentas: deuda vieja primero y luego mes actual.
      remaining = take(state.priorBs, remaining);
      remaining = take(state.priorUsd, remaining);
      remaining = take(state.currentBs, remaining);
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

  const currentBsAfterTimely = money(state.currentBs.value);
  const timelyPaidBsRef = money(Math.max(0, promptPaymentRequiredBsRef - currentBsAfterTimely));
  const promptPaymentComplied = currentBsAfterTimely <= TOLERANCE;
  const recargoBsRef = clock.day > 10 && charges.bsRef > TOLERANCE && !promptPaymentComplied
    ? money(charges.bsRef * 0.10)
    : 0;
  state.currentBs.value = money(state.currentBs.value + recargoBsRef);

  for (const payment of late) applyPayment(payment);

  const expiredUsd = money(state.priorUsd.value);
  const expiredBsRef = money(state.priorBs.value);
  const currentUsd = money(state.currentUsd.value - state.creditUsd);
  const currentBsRef = money(state.currentBs.value - state.creditBs);
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
    recargoBsRef,
    paidUsd,
    paidBsRef,
    paidLegacyRef,
    timelyPaidBsRef,
    promptPaymentRequiredBsRef,
    promptPaymentComplied,
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

function calculatedFields(balance, owner) {
  const ownerFields = fieldsOf(owner);
  return {
    'Deuda Restante Airtable': money(ownerFields['Deuda Restante']),
    'Recargo Airtable': money(ownerFields['Recargo Aplicado']),
    'Deuda Restante': balance.totalRef,
    'Recargo Aplicado': balance.recargoBsRef,
    'Saldo USD Actual': balance.usd,
    'Saldo Bs Ref Actual': balance.bsRef,
    'Saldo Total Actual': balance.totalRef,
    'Deuda Vencida USD': balance.expiredUsd,
    'Deuda Vencida Bs Ref': balance.expiredBsRef,
    'Deuda Vencida Total': balance.expiredTotalRef,
    'Mes Corriente USD': balance.currentUsd,
    'Mes Corriente Bs Ref': balance.currentBsRef,
    'Mes Corriente Total': balance.currentTotalRef,
    'Cargos Mes USD': balance.chargesUsd,
    'Cargos Mes Bs Ref': balance.chargesBsRef,
    'Base Pronto Pago Bs Ref': balance.promptPaymentRequiredBsRef,
    'Pago Oportuno Bs Ref': balance.timelyPaidBsRef,
    'Pronto Pago Cumplido': balance.promptPaymentComplied,
    'Mes Calculo': balance.month,
    'Dia Calculo': balance.day
  };
}

function calculateAllOwners(owners = [], expenses = [], payments = [], options = {}) {
  const byId = new Map();
  for (const owner of owners || []) {
    const balance = calculateOwnerBalance(owner, expenses, payments, options);
    byId.set(recordId(owner), balance);
  }
  return byId;
}

module.exports = {
  TOLERANCE,
  money,
  selectName,
  fieldsOf,
  ownerShare,
  paymentEquivalentUsd,
  isAppliedPayment,
  caracasClock,
  calculateOwnerBalance,
  calculatedFields,
  calculateAllOwners
};
