'use strict';

const base = require('./_balance_engine');
const { money, fieldsOf, selectName, ownerShare, paymentEquivalentUsd, isAppliedPayment } = base;

const OFFICIAL_FIELDS = {
  month: 'Mes Saldo Oficial',
  usd: 'Saldo Oficial USD Base',
  bs: 'Saldo Oficial Bs Ref Base',
  surcharge: 'Base Recargo Oficial Bs Ref',
  cutoff: 'Corte Saldo Oficial'
};

function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean)
    : [];
}

function recordCreatedAt(record) {
  const value = Date.parse(String(record && record.createdTime || ''));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function paymentMode(payment) {
  const value = selectName(fieldsOf(payment)['Forma de Pago']).trim();
  if (value === 'USD') return 'USD';
  if (value === 'Bs BCV') return 'Bs BCV';
  return 'LEGACY';
}

function officialSnapshot(owner, month) {
  const fields = fieldsOf(owner);
  const snapshotMonth = String(fields[OFFICIAL_FIELDS.month] || '').trim();
  const cutoff = String(fields[OFFICIAL_FIELDS.cutoff] || '').trim();
  const cutoffMs = Date.parse(cutoff);
  if (snapshotMonth !== month || !Number.isFinite(cutoffMs)) return null;
  return {
    month: snapshotMonth,
    usd: money(fields[OFFICIAL_FIELDS.usd]),
    bsRef: money(fields[OFFICIAL_FIELDS.bs]),
    surchargeBaseBsRef: money(Math.max(0, Number(fields[OFFICIAL_FIELDS.surcharge] || 0))),
    cutoff,
    cutoffMs
  };
}

function chargeLines(owner, expenses) {
  let usd = 0;
  let bsRef = 0;
  const expenseLinesUsd = [];
  const expenseLinesBs = [];
  for (const expense of expenses || []) {
    const amount = ownerShare(expense, owner);
    if (Math.abs(amount) <= base.TOLERANCE) continue;
    const fields = fieldsOf(expense);
    const mode = selectName(fields['Forma de Pago']) === 'USD' ? 'USD' : 'Bs BCV';
    const line = {
      id: String(expense && expense.id || ''),
      concept: String(fields.Concepto || 'Gasto'),
      amount,
      mode
    };
    if (mode === 'USD') {
      usd = money(usd + amount);
      expenseLinesUsd.push(line);
    } else {
      bsRef = money(bsRef + amount);
      expenseLinesBs.push(line);
    }
  }
  return { usd, bsRef, expenseLinesUsd, expenseLinesBs };
}

function applyPositivePayment(balance, amount) {
  const used = Math.min(Math.max(0, balance), Math.max(0, amount));
  return { balance: money(balance - used), remaining: money(amount - used) };
}

function calculateOfficialBalance(owner, expenses, payments, clock, snapshot) {
  const ownerId = String(owner && owner.id || '');
  const newExpenses = (expenses || []).filter(record => recordCreatedAt(record) > snapshot.cutoffMs);
  const chargesAfterCutoff = chargeLines(owner, newExpenses);
  let usd = money(snapshot.usd + chargesAfterCutoff.usd);
  let bsRef = money(snapshot.bsRef + chargesAfterCutoff.bsRef);
  const recargoBsRef = clock.day > 10 && snapshot.surchargeBaseBsRef > base.TOLERANCE
    ? money(snapshot.surchargeBaseBsRef * 0.10)
    : 0;
  bsRef = money(bsRef + recargoBsRef);

  const activePayments = (payments || [])
    .filter(payment => !isAppliedPayment(payment))
    .filter(payment => linkedIds(fieldsOf(payment)['Propietario que Paga']).includes(ownerId))
    .filter(payment => recordCreatedAt(payment) > snapshot.cutoffMs)
    .sort((left, right) => recordCreatedAt(left) - recordCreatedAt(right) ||
      String(left && left.id || '').localeCompare(String(right && right.id || '')));

  let paidUsd = 0;
  let paidBsRef = 0;
  let paidLegacyRef = 0;
  for (const payment of activePayments) {
    const amount = paymentEquivalentUsd(payment);
    const mode = paymentMode(payment);
    if (mode === 'USD') {
      paidUsd = money(paidUsd + amount);
      usd = money(usd - amount);
    } else if (mode === 'Bs BCV') {
      paidBsRef = money(paidBsRef + amount);
      bsRef = money(bsRef - amount);
    } else {
      paidLegacyRef = money(paidLegacyRef + amount);
      let remaining = amount;
      if (bsRef > 0) {
        const applied = applyPositivePayment(bsRef, remaining);
        bsRef = applied.balance;
        remaining = applied.remaining;
      }
      if (remaining > 0 && usd > 0) {
        const applied = applyPositivePayment(usd, remaining);
        usd = applied.balance;
        remaining = applied.remaining;
      }
      if (remaining > 0) bsRef = money(bsRef - remaining);
    }
  }

  const baseConcept = 'Saldo corriente oficial al corte';
  const expenseLinesUsd = [
    ...(Math.abs(snapshot.usd) > base.TOLERANCE ? [{ id:`official-${ownerId}-usd`, concept:baseConcept, amount:snapshot.usd, mode:'USD' }] : []),
    ...chargesAfterCutoff.expenseLinesUsd
  ];
  const expenseLinesBs = [
    ...(Math.abs(snapshot.bsRef) > base.TOLERANCE ? [{ id:`official-${ownerId}-bs`, concept:baseConcept, amount:snapshot.bsRef, mode:'Bs BCV' }] : []),
    ...chargesAfterCutoff.expenseLinesBs
  ];

  return {
    ownerId,
    month: clock.month,
    day: clock.day,
    officialSnapshotActive: true,
    officialCutoff: snapshot.cutoff,
    priorUsd: 0,
    priorBsRef: 0,
    priorLegacyTotal: 0,
    chargesUsd: money(snapshot.usd + chargesAfterCutoff.usd),
    chargesBsRef: money(snapshot.bsRef + chargesAfterCutoff.bsRef),
    recargoBsRef,
    paidUsd,
    paidBsRef,
    paidLegacyRef,
    timelyPaidBsRef: 0,
    promptPaymentRequiredBsRef: snapshot.surchargeBaseBsRef,
    promptPaymentComplied: recargoBsRef <= base.TOLERANCE,
    usd,
    bsRef,
    totalRef: money(usd + bsRef),
    expiredUsd: 0,
    expiredBsRef: 0,
    expiredTotalRef: 0,
    currentUsd: usd,
    currentBsRef: bsRef,
    currentTotalRef: money(usd + bsRef),
    activePayments,
    expenseLinesUsd,
    expenseLinesBs
  };
}

function calculateOwnerBalance(owner, expenses = [], payments = [], options = {}) {
  const clock = options.month
    ? { month:String(options.month), day:Number(options.day || 31) }
    : base.caracasClock(options.now || new Date());
  const snapshot = officialSnapshot(owner, clock.month);
  if (snapshot) return calculateOfficialBalance(owner, expenses, payments, clock, snapshot);
  const result = base.calculateOwnerBalance(owner, expenses, payments, options);
  return Object.assign({}, result, { officialSnapshotActive:false, officialCutoff:'' });
}

function calculateAllOwners(owners = [], expenses = [], payments = [], options = {}) {
  const byId = new Map();
  for (const owner of owners || []) {
    byId.set(String(owner && owner.id || ''), calculateOwnerBalance(owner, expenses, payments, options));
  }
  return byId;
}

function calculatedFields(balance, owner) {
  return Object.assign({}, base.calculatedFields(balance, owner), {
    'Saldo Oficial Activo': balance.officialSnapshotActive === true,
    'Corte Saldo Oficial': balance.officialCutoff || ''
  });
}

module.exports = Object.assign({}, base, {
  OFFICIAL_FIELDS,
  officialSnapshot,
  calculateOwnerBalance,
  calculateAllOwners,
  calculatedFields
});
