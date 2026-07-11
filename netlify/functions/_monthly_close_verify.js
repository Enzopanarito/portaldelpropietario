'use strict';

const { debtFields, currentDebtValues, compareDebtValues, isBeforeOrTarget } = require('./_monthly_close_core');
const { TABLES, getAll, patchBatches } = require('./_monthly_close_store');

async function verifyPlan(plan, expectedState, token, baseId, counter) {
  const [owners, payments] = await Promise.all([
    getAll(TABLES.owners, '', token, baseId, counter),
    getAll(TABLES.payments, '', token, baseId, counter)
  ]);
  const ownersById = new Map(owners.map(owner => [owner.id, owner]));
  const paymentsById = new Map(payments.map(payment => [payment.id, payment]));
  const ownerDifferences = [];
  const paymentDifferences = [];

  for (const item of plan.ownerUpdates || []) {
    const owner = ownersById.get(item.id);
    if (!owner) {
      ownerDifferences.push({ ownerId: item.id, reason: 'propietario no encontrado' });
      continue;
    }
    const expected = expectedState === 'target' ? item.target : item.before;
    const comparison = compareDebtValues(expected, currentDebtValues(owner));
    if (!comparison.ok) ownerDifferences.push({ ownerId: item.id, casa: item.casa, differences: comparison.differences });
  }

  for (const paymentId of plan.paymentIds || []) {
    const payment = paymentsById.get(paymentId);
    if (!payment) {
      paymentDifferences.push({ paymentId, reason: 'pago no encontrado' });
      continue;
    }
    const applied = payment?.fields?.['[x] Aplicado al Cierre'] === true;
    const expectedApplied = expectedState === 'target';
    if (applied !== expectedApplied) paymentDifferences.push({ paymentId, expectedApplied, applied });
  }
  return { ok: ownerDifferences.length === 0 && paymentDifferences.length === 0, ownerDifferences, paymentDifferences };
}

async function restorePlan(plan, token, baseId, counter) {
  const [owners, payments] = await Promise.all([
    getAll(TABLES.owners, '', token, baseId, counter),
    getAll(TABLES.payments, '', token, baseId, counter)
  ]);
  const ownersById = new Map(owners.map(owner => [owner.id, owner]));
  const paymentsById = new Map(payments.map(payment => [payment.id, payment]));
  const conflicts = [];

  for (const item of plan.ownerUpdates || []) {
    const owner = ownersById.get(item.id);
    if (!owner) {
      conflicts.push({ ownerId: item.id, reason: 'propietario no encontrado' });
      continue;
    }
    const current = currentDebtValues(owner);
    if (!isBeforeOrTarget(current, item)) conflicts.push({ ownerId: item.id, casa: item.casa, reason: 'valores distintos al estado anterior y al objetivo', current });
  }
  for (const paymentId of plan.paymentIds || []) {
    if (!paymentsById.has(paymentId)) conflicts.push({ paymentId, reason: 'pago no encontrado' });
  }
  if (conflicts.length) return { ok: false, conflicts, verification: null };

  const paymentsToRestore = (plan.paymentIds || []).map(id => ({ id, fields: { '[x] Aplicado al Cierre': false } }));
  const ownersToRestore = (plan.ownerUpdates || []).map(item => ({ id: item.id, fields: debtFields(item.before) }));
  await patchBatches(TABLES.payments, paymentsToRestore, token, baseId, counter);
  await patchBatches(TABLES.owners, ownersToRestore, token, baseId, counter);
  const verification = await verifyPlan(plan, 'before', token, baseId, counter);
  return { ok: verification.ok, conflicts: [], verification };
}

module.exports = { verifyPlan, restorePlan };
