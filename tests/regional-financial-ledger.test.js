'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFixed, formatFixed } = require('../platform/core/fixed-decimal');
const { aggregateLedger, balanceForCurrency, hasMixedDebtAndCredit, payableByCurrency } = require('../platform/core/financial-ledger');

test('fixed decimal arithmetic never uses floating point rounding', () => {
  assert.equal(formatFixed(parseFixed('0.1') + parseFixed('0.2')), '0.3');
  assert.equal(formatFixed(parseFixed('294.760000')), '294.76');
  assert.throws(() => parseFixed('1.0000001'), error => error.code === 'AMOUNT_PRECISION_EXCEEDED');
});

test('USD and VES balances remain independent', () => {
  const balances = aggregateLedger([
    { currencyCode: 'USD', amount: '100' },
    { currencyCode: 'USD', amount: '-40' },
    { currencyCode: 'VES', amount: '1000' }
  ]);
  assert.deepEqual(balances.map(({currencyCode,balance,amountDue,creditAvailable}) => ({currencyCode,balance,amountDue,creditAvailable})), [
    { currencyCode: 'USD', balance: '60', amountDue: '60', creditAvailable: '0' },
    { currencyCode: 'VES', balance: '1000', amountDue: '1000', creditAvailable: '0' }
  ]);
});

test('a credit in one currency never silently cancels debt in another', () => {
  const balances = aggregateLedger([
    { currencyCode: 'USD', amount: '70' },
    { currencyCode: 'VES', amount: '-0.03' }
  ]);
  assert.equal(balanceForCurrency(balances.map(x => ({currencyCode:x.currencyCode,amount:x.balance})), 'USD').amountDue, '70');
  assert.equal(balanceForCurrency(balances.map(x => ({currencyCode:x.currencyCode,amount:x.balance})), 'VES').creditAvailable, '0.03');
  assert.equal(hasMixedDebtAndCredit(balances), true);
  assert.deepEqual(payableByCurrency([
    { currencyCode: 'USD', amount: '70' },
    { currencyCode: 'VES', amount: '-0.03' }
  ]), [{ currencyCode: 'USD', amountDue: '70' }]);
});

test('VLA Casa 11 semantic pattern survives generically', () => {
  const balances = aggregateLedger([
    { currencyCode: 'USD', amount: '50' },
    { currencyCode: 'VES', amount: '-294.76' }
  ]);
  const usd = balances.find(row => row.currencyCode === 'USD');
  const ves = balances.find(row => row.currencyCode === 'VES');
  assert.equal(usd.amountDue, '50');
  assert.equal(ves.creditAvailable, '294.76');
  assert.equal(hasMixedDebtAndCredit(balances), true);
});

test('invalid currencies and zero entries fail closed', () => {
  assert.throws(() => aggregateLedger([{ currencyCode: 'US', amount: '1' }]), error => error.code === 'CURRENCY_INVALID');
  assert.throws(() => aggregateLedger([{ currencyCode: 'USD', amount: '0' }]), error => error.code === 'LEDGER_ZERO_AMOUNT');
});
