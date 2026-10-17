'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv, stringifyCsv } = require('../platform/onboarding/csv');
const { createImportPlan } = require('../platform/onboarding/import-plan');

const templatePath = path.join(__dirname, '..', 'config', 'import-templates', 'community-onboarding-v1.csv');

test('CSV parser handles quoted commas, quotes and CRLF safely', () => {
  const rows = parseCsv('unit_code,owner_name\r\nA-1,"Doe, Jane"\r\nA-2,"Say ""Hello"""\r\n');
  assert.deepEqual(rows, [
    { unit_code: 'A-1', owner_name: 'Doe, Jane' },
    { unit_code: 'A-2', owner_name: 'Say "Hello"' }
  ]);
  const encoded = stringifyCsv(['unit_code','owner_name'], rows);
  assert.deepEqual(parseCsv(encoded), rows);
});

test('official onboarding template produces a reconciled plan without currency netting', () => {
  const rows = parseCsv(fs.readFileSync(templatePath, 'utf8'));
  const plan = createImportPlan(rows, { currencies: ['USD','VES'] });
  assert.equal(plan.ready, true);
  assert.equal(plan.reconciliation.acceptedUnits, 2);
  assert.equal(plan.structures.length, 1);
  assert.equal(plan.people.length, 2);
  assert.deepEqual(plan.reconciliation.openingTotals, [
    { currencyCode: 'USD', balance: '100', amountDue: '100', netCredit: '0' },
    { currencyCode: 'VES', balance: '475', amountDue: '475', netCredit: '0' }
  ]);
  assert.deepEqual(plan.openingEntries.map(x => [x.unitKey,x.currencyCode,x.amount]), [
    ['unit:a-101','USD','100'],
    ['unit:a-101','VES','-25'],
    ['unit:a-102','VES','500']
  ]);
});

test('duplicate units block materialization', () => {
  const plan = createImportPlan([
    { unit_code: '101', owner_name: 'One' },
    { unit_code: '101', owner_name: 'Two' }
  ], { currencies: ['USD'] });
  assert.equal(plan.ready, false);
  assert.equal(plan.errors.some(error => error.code === 'UNIT_CODE_DUPLICATE'), true);
});

test('same person_key can own multiple units only when identity data matches', () => {
  const good = createImportPlan([
    { unit_code: '101', person_key: 'p1', owner_name: 'Owner', owner_email: 'owner@example.com' },
    { unit_code: '102', person_key: 'p1', owner_name: 'Owner', owner_email: 'owner@example.com' }
  ], { currencies: ['USD'] });
  assert.equal(good.ready, true);
  assert.equal(good.people.length, 1);
  assert.equal(good.memberships.length, 2);

  const bad = createImportPlan([
    { unit_code: '101', person_key: 'p1', owner_name: 'Owner One' },
    { unit_code: '102', person_key: 'p1', owner_name: 'Owner Two' }
  ], { currencies: ['USD'] });
  assert.equal(bad.ready, false);
  assert.equal(bad.errors.some(error => error.code === 'PERSON_KEY_CONFLICT'), true);
});

test('missing owner is a warning, not a fabricated person', () => {
  const plan = createImportPlan([{ unit_code: '101', opening_USD: '20' }], { currencies: ['USD'] });
  assert.equal(plan.ready, true);
  assert.equal(plan.people.length, 0);
  assert.equal(plan.memberships.length, 0);
  assert.equal(plan.warnings[0].code, 'OWNER_MISSING');
});

test('invalid balances, coefficient and unsupported unit types fail closed', () => {
  const badBalance = createImportPlan([{ unit_code: '101', owner_name: 'A', opening_USD: '1.0000001' }], { currencies: ['USD'] });
  assert.equal(badBalance.ready, false);
  assert.equal(badBalance.errors.some(error => error.code === 'AMOUNT_PRECISION_EXCEEDED'), true);

  const badCoefficient = createImportPlan([{ unit_code: '101', owner_name: 'A', ownership_coefficient: '-1' }], { currencies: ['USD'] });
  assert.equal(badCoefficient.ready, false);
  assert.equal(badCoefficient.errors.some(error => error.code === 'OWNERSHIP_COEFFICIENT_INVALID'), true);

  const badUnit = createImportPlan([{ unit_code: '101', owner_name: 'A', unit_type: 'spaceship' }], { currencies: ['USD'] });
  assert.equal(badUnit.ready, false);
  assert.equal(badUnit.errors.some(error => error.code === 'UNIT_TYPE_INVALID'), true);
});

test('opening credits and debts remain independent per currency', () => {
  const plan = createImportPlan([
    { unit_code: '101', owner_name: 'A', opening_USD: '70', opening_VES: '-294.76' }
  ], { currencies: ['USD','VES'] });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.reconciliation.openingTotals, [
    { currencyCode: 'USD', balance: '70', amountDue: '70', netCredit: '0' },
    { currencyCode: 'VES', balance: '-294.76', amountDue: '0', netCredit: '294.76' }
  ]);
});
