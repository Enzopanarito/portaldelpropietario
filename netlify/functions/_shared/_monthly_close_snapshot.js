'use strict';

const { money, hashJson } = require('./_monthly_close_core');

const ROWS_PER_OWNER = 10;

function status(total) {
  if (total > 0.01) return 'Deuda';
  if (total < -0.01) return 'Saldo a favor';
  return 'Solvente';
}

function concept(month, casa, label, ownerName) {
  return `AUDITORIA|${month}|Casa ${casa}|${label} | ${ownerName}`;
}

function expectedSnapshotEntries(plan) {
  const entries = [];
  for (const item of plan?.ownerUpdates || []) {
    const c = item.calculation || {};
    const ownerName = String(item.propietario || 'Sin nombre');
    const casa = item.casa ?? 'N/A';
    const values = [
      ['Saldo inicial USD', money(c.priorUsd)],
      ['Saldo inicial Bs Ref', money(c.priorBsRef)],
      ['Cargos USD', money(c.chargesUsd)],
      ['Cargos Bs Ref', money(c.chargesBsRef)],
      ['Pagos USD', -Math.abs(money(c.paidUsd))],
      ['Pagos Bs Ref', -Math.abs(money(c.paidBsRef))],
      ['Saldo final USD', money(item.target?.deudaAnteriorUsd)],
      ['Saldo final Bs Ref', money(item.target?.deudaAnteriorBsRef)],
      [`Saldo final total (${status(money(item.target?.deudaAnterior))})`, money(item.target?.deudaAnterior)],
      ['Modo de cálculo doble moneda', 0]
    ];
    for (const [label, amount] of values) {
      entries.push({
        ownerId: item.id,
        casa,
        ownerName,
        concept: concept(plan.month, casa, label, ownerName),
        amount: money(amount)
      });
    }
  }
  return entries.sort((a, b) => a.concept.localeCompare(b.concept));
}

function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean).sort()
    : [];
}

function canonicalEntry(entry) {
  return {
    concept: String(entry.concept || ''),
    ownerId: String(entry.ownerId || ''),
    amount: money(entry.amount)
  };
}

function actualEntry(record) {
  const fields = record?.fields || {};
  const owners = linkedIds(fields.Propietario);
  return {
    concept: String(fields.Concepto || ''),
    ownerId: String(owners[0] || ''),
    ownerIds: owners,
    amount: money(fields['Monto Cargado'])
  };
}

function snapshotHash(entries) {
  return hashJson((entries || []).map(canonicalEntry).sort((a, b) => a.concept.localeCompare(b.concept)));
}

function validateSnapshotRecords(records = [], plan = {}) {
  const expected = expectedSnapshotEntries(plan);
  const expectedByConcept = new Map(expected.map(entry => [entry.concept, entry]));
  const actual = (records || []).map(actualEntry).filter(entry => entry.concept.startsWith(`AUDITORIA|${plan.month}|`));
  const actualByConcept = new Map();
  const duplicates = [];
  for (const entry of actual) {
    if (actualByConcept.has(entry.concept)) duplicates.push(entry.concept);
    else actualByConcept.set(entry.concept, entry);
  }

  const missing = [];
  const mismatched = [];
  for (const expectedEntry of expected) {
    const current = actualByConcept.get(expectedEntry.concept);
    if (!current) {
      missing.push(expectedEntry.concept);
      continue;
    }
    const amountOk = Math.abs(money(current.amount - expectedEntry.amount)) <= 0.001;
    const ownerOk = current.ownerIds.length === 1 && current.ownerIds[0] === expectedEntry.ownerId;
    if (!amountOk || !ownerOk) {
      mismatched.push({
        concept: expectedEntry.concept,
        expectedAmount: expectedEntry.amount,
        actualAmount: current.amount,
        expectedOwnerId: expectedEntry.ownerId,
        actualOwnerIds: current.ownerIds
      });
    }
  }

  const unexpected = actual.filter(entry => !expectedByConcept.has(entry.concept)).map(entry => entry.concept);
  const expectedCount = Number(plan?.ownerUpdates?.length || 0) * ROWS_PER_OWNER;
  const complete = expectedCount > 0 && expected.length === expectedCount && actual.length === expectedCount &&
    missing.length === 0 && mismatched.length === 0 && duplicates.length === 0 && unexpected.length === 0;

  const canonicalActual = actual.map(entry => ({ concept:entry.concept, ownerId:entry.ownerId, amount:entry.amount }));
  return {
    complete,
    count: actual.length,
    expected: expectedCount,
    expectedHash: snapshotHash(expected),
    actualHash: snapshotHash(canonicalActual),
    missing,
    mismatched,
    duplicates,
    unexpected
  };
}

module.exports = {
  ROWS_PER_OWNER,
  status,
  concept,
  expectedSnapshotEntries,
  snapshotHash,
  validateSnapshotRecords
};
