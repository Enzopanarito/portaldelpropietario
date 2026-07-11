'use strict';

const TOLERANCE = 0.01;

function money(value) {
  const number = Number(value || 0);
  return Math.abs(number) < 0.005 ? 0 : Math.round(number * 100) / 100;
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

function ownerShare(expense, owner) {
  const expenseFields = fieldsOf(expense);
  const ownerFields = fieldsOf(owner);
  const amount = Number(expenseFields.Monto || 0);
  const type = selectName(expenseFields['Tipo de Gasto']);
  const linkedOwners = Array.isArray(expenseFields.Propietarios) ? expenseFields.Propietarios.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean) : [];
  const ownerId = recordId(owner);
  const aliquot = Number(ownerFields.Alicuota || 0);

  if (type === 'Gasto Común') return money(amount * aliquot);
  if (type === 'Gasto Especial' && linkedOwners.includes(ownerId)) return money(amount / Math.max(1, linkedOwners.length));
  return 0;
}

function paymentOwnerIds(payment) {
  const linked = fieldsOf(payment)['Propietario que Paga'] || [];
  return Array.isArray(linked) ? linked.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean) : [];
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

function paymentDateParts(payment) {
  const raw = String(fieldsOf(payment)['Fecha de Pago'] || '').slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { month: '', day: 0 };
  return { month: `${match[1]}-${match[2]}`, day: Number(match[3]) };
}

function normalizeMode(value) {
  return selectName(value) === 'USD' ? 'USD' : 'Bs BCV';
}

function calculateOwnerBalance(owner, expenses = [], payments = [], options = {}) {
  const ownerFields = fieldsOf(owner);
  const ownerId = recordId(owner);
  const clock = options.month
    ? { month: String(options.month), day: Number(options.day || 31) }
    : caracasClock(options.now || new Date());

  let priorUsd = money(ownerFields['Deuda Anterior USD']);
  let priorBsRef = money(ownerFields['Deuda Anterior Bs Ref']);
  const hasSplit = Math.abs(priorUsd) > 0.001 || Math.abs(priorBsRef) > 0.001;
  if (!hasSplit) priorBsRef = money(priorBsRef + Number(ownerFields['Deuda Anterior'] || 0));

  let chargesUsd = 0;
  let chargesBsRef = 0;
  const expenseLinesUsd = [];
  const expenseLinesBs = [];

  for (const expense of expenses || []) {
    const share = ownerShare(expense, owner);
    if (share <= TOLERANCE) continue;
    const expenseFields = fieldsOf(expense);
    const mode = normalizeMode(expenseFields['Forma de Pago']);
    const line = {
      id: recordId(expense),
      concept: String(expenseFields.Concepto || 'Gasto'),
      amount: share,
      mode
    };
    if (mode === 'USD') {
      chargesUsd = money(chargesUsd + share);
      expenseLinesUsd.push(line);
    } else {
      chargesBsRef = money(chargesBsRef + share);
      expenseLinesBs.push(line);
    }
  }

  let paidUsd = 0;
  let paidBsRef = 0;
  let timelyPaidBsRef = 0;
  const activePayments = [];

  for (const payment of payments || []) {
    if (isAppliedPayment(payment) || !paymentOwnerIds(payment).includes(ownerId)) continue;
    const paymentFields = fieldsOf(payment);
    const mode = normalizeMode(paymentFields['Forma de Pago']);
    const amount = paymentEquivalentUsd(payment);
    const date = paymentDateParts(payment);
    activePayments.push(payment);
    if (mode === 'USD') paidUsd = money(paidUsd + amount);
    else {
      paidBsRef = money(paidBsRef + amount);
      if (date.month === clock.month && date.day > 0 && date.day <= 10) {
        timelyPaidBsRef = money(timelyPaidBsRef + amount);
      }
    }
  }

  // El beneficio de pronto pago aplica únicamente a la cuenta de condominio en Bs.
  // Para conservarlo, los pagos en Bs realizados hasta el día 10 deben cubrir la deuda
  // anterior en Bs más todos los cargos corrientes pagaderos en Bs. Pagos USD no cuentan.
  const promptPaymentRequiredBsRef = money(Math.max(0, priorBsRef + chargesBsRef));
  const promptPaymentComplied = timelyPaidBsRef + TOLERANCE >= promptPaymentRequiredBsRef;
  const recargoBsRef = clock.day > 10 && chargesBsRef > TOLERANCE && !promptPaymentComplied
    ? money(chargesBsRef * 0.10)
    : 0;

  let usd = money(priorUsd + chargesUsd - paidUsd);
  let bsRef = money(priorBsRef + chargesBsRef + recargoBsRef - paidBsRef);
  if (Math.abs(usd) <= TOLERANCE) usd = 0;
  if (Math.abs(bsRef) <= TOLERANCE) bsRef = 0;

  // Los pagos activos se aplican primero a la deuda anterior de su misma moneda.
  const positivePriorUsd = Math.max(0, priorUsd);
  const positivePriorBs = Math.max(0, priorBsRef);
  const expiredUsd = money(Math.max(0, positivePriorUsd - paidUsd));
  const expiredBsRef = money(Math.max(0, positivePriorBs - paidBsRef));
  const paymentRemainingUsd = money(Math.max(0, paidUsd - positivePriorUsd));
  const paymentRemainingBs = money(Math.max(0, paidBsRef - positivePriorBs));
  const currentUsd = money(chargesUsd - paymentRemainingUsd);
  const currentBsRef = money(chargesBsRef + recargoBsRef - paymentRemainingBs);

  return {
    ownerId,
    month: clock.month,
    day: clock.day,
    priorUsd,
    priorBsRef,
    chargesUsd,
    chargesBsRef,
    recargoBsRef,
    paidUsd,
    paidBsRef,
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
    expenseLinesUsd,
    expenseLinesBs
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
