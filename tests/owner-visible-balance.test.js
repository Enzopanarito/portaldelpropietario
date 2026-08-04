'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerVisibleBalance } = require('../scripts/owner-visible-balance');

test('muestra la suma pagadera cuando existe deuda positiva en alguna cuenta', () => {
  assert.deepEqual(ownerVisibleBalance({
    'Saldo USD Actual': 85,
    'Saldo Bs Ref Actual': -20,
    'Saldo Total Actual': 65
  }), {
    usd: 85,
    bsRef: -20,
    net: 65,
    payable: 85,
    visible: 85
  });
});

test('muestra el saldo neto negativo cuando ambas cuentas están a favor o en cero', () => {
  assert.equal(ownerVisibleBalance({
    'Saldo USD Actual': -20,
    'Saldo Bs Ref Actual': 0,
    'Saldo Total Actual': -20
  }).visible, -20);

  assert.equal(ownerVisibleBalance({
    'Saldo USD Actual': 0,
    'Saldo Bs Ref Actual': -378.89,
    'Saldo Total Actual': -378.89
  }).visible, -378.89);
});

test('muestra cero cuando no existe deuda ni saldo a favor', () => {
  assert.equal(ownerVisibleBalance({
    'Saldo USD Actual': 0,
    'Saldo Bs Ref Actual': 0,
    'Saldo Total Actual': 0
  }).visible, 0);
});
