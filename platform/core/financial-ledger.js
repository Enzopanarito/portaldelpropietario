'use strict';

const { DEFAULT_SCALE, parseFixed, formatFixed, positive, negativeMagnitude } = require('./fixed-decimal');

function normalizeCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw Object.assign(new Error(`Invalid currency: ${value}`), { code: 'CURRENCY_INVALID' });
  }
  return code;
}

function normalizeEntry(entry, scale = DEFAULT_SCALE) {
  if (!entry || typeof entry !== 'object') {
    throw Object.assign(new Error('Ledger entry must be an object'), { code: 'LEDGER_ENTRY_INVALID' });
  }
  const currency = normalizeCurrency(entry.currencyCode ?? entry.currency_code);
  const amount = parseFixed(entry.amount, scale);
  if (amount === 0n) {
    throw Object.assign(new Error('Ledger entry amount cannot be zero'), { code: 'LEDGER_ZERO_AMOUNT' });
  }
  return { currency, amount };
}

function aggregateLedger(entries, { scale = DEFAULT_SCALE } = {}) {
  if (!Array.isArray(entries)) {
    throw Object.assign(new Error('Ledger entries must be an array'), { code: 'LEDGER_ENTRIES_REQUIRED' });
  }

  const balances = new Map();
  for (const rawEntry of entries) {
    const entry = normalizeEntry(rawEntry, scale);
    balances.set(entry.currency, (balances.get(entry.currency) || 0n) + entry.amount);
  }

  return [...balances.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, balanceScaled]) => ({
      currencyCode,
      balance: formatFixed(balanceScaled, scale),
      amountDue: formatFixed(positive(balanceScaled), scale),
      creditAvailable: formatFixed(negativeMagnitude(balanceScaled), scale),
      balanceScaled
    }));
}

function balanceForCurrency(entries, currencyCode, options = {}) {
  const currency = normalizeCurrency(currencyCode);
  return aggregateLedger(entries, options).find(item => item.currencyCode === currency) || {
    currencyCode: currency,
    balance: '0',
    amountDue: '0',
    creditAvailable: '0',
    balanceScaled: 0n
  };
}

function hasMixedDebtAndCredit(balances) {
  const rows = Array.isArray(balances) ? balances : [];
  return rows.some(row => BigInt(row.balanceScaled) > 0n) && rows.some(row => BigInt(row.balanceScaled) < 0n);
}

function payableByCurrency(entries, options = {}) {
  return aggregateLedger(entries, options)
    .filter(row => BigInt(row.balanceScaled) > 0n)
    .map(({ currencyCode, amountDue }) => ({ currencyCode, amountDue }));
}

module.exports = {
  normalizeCurrency,
  normalizeEntry,
  aggregateLedger,
  balanceForCurrency,
  hasMixedDebtAndCredit,
  payableByCurrency
};
