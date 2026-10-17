'use strict';

const DEFAULT_SCALE = 6;

function pow10(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 12) {
    throw Object.assign(new Error('Invalid decimal scale'), { code: 'DECIMAL_SCALE_INVALID' });
  }
  return 10n ** BigInt(scale);
}

function parseFixed(value, scale = DEFAULT_SCALE) {
  if (typeof value === 'bigint') return value;
  const raw = String(value ?? '').trim();
  if (!raw) throw Object.assign(new Error('Amount is required'), { code: 'AMOUNT_REQUIRED' });
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    throw Object.assign(new Error(`Invalid decimal amount: ${raw}`), { code: 'AMOUNT_INVALID' });
  }

  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) {
    const excess = fraction.slice(scale);
    if (!/^0*$/.test(excess)) {
      throw Object.assign(new Error(`Amount exceeds ${scale} decimal places`), { code: 'AMOUNT_PRECISION_EXCEEDED' });
    }
  }
  const padded = (fraction.slice(0, scale) + '0'.repeat(scale)).slice(0, scale);
  const scaled = BigInt(whole) * pow10(scale) + BigInt(padded || '0');
  return negative ? -scaled : scaled;
}

function formatFixed(value, scale = DEFAULT_SCALE, { trim = true } = {}) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const factor = pow10(scale);
  const whole = absolute / factor;
  let fraction = String(absolute % factor).padStart(scale, '0');
  if (trim) fraction = fraction.replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : String(whole);
  return negative && absolute !== 0n ? `-${body}` : body;
}

function positive(value) {
  const amount = BigInt(value);
  return amount > 0n ? amount : 0n;
}

function negativeMagnitude(value) {
  const amount = BigInt(value);
  return amount < 0n ? -amount : 0n;
}

module.exports = {
  DEFAULT_SCALE,
  parseFixed,
  formatFixed,
  positive,
  negativeMagnitude
};
