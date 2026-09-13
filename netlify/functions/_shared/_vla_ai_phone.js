'use strict';

const OWNER_PHONE_FIELDS = Object.freeze([
  'Telefono', 'Teléfono', 'WhatsApp', 'Telefono WhatsApp', 'Teléfono WhatsApp',
  'Telefono 2', 'Teléfono 2', 'Telefono Alterno', 'Teléfono Alterno'
]);

function clean(value) { return String(value ?? '').trim(); }
function digits(value) { return clean(value).replace(/\D/g, ''); }

function normalizePhone(value) {
  const text = clean(value);
  if (!text) return '';
  let raw = digits(text);
  if (!raw) return '';

  // Explicit international formats: +CC... or 00CC...
  if (text.startsWith('+')) {
    return raw.length >= 8 && raw.length <= 15 && raw[0] !== '0' ? `+${raw}` : '';
  }
  if (raw.startsWith('00')) {
    raw = raw.slice(2);
    return raw.length >= 8 && raw.length <= 15 && raw[0] !== '0' ? `+${raw}` : '';
  }

  // Venezuela: accept country-code form without + and common national formats.
  if (raw.startsWith('58') && raw.length === 12 && raw[2] === '4') return `+${raw}`;
  if (raw.startsWith('0') && raw.length === 11 && raw[1] === '4') return `+58${raw.slice(1)}`;
  if (raw.length === 10 && raw[0] === '4') return `+58${raw}`;

  return '';
}

// Backward-compatible export used by the first staging tests.
const normalizeVenezuelanPhone = normalizePhone;

function candidateStrings(value) {
  if (Array.isArray(value)) return value.flatMap(candidateStrings);
  if (value === null || value === undefined) return [];
  const text = clean(value);
  if (!text) return [];
  const extracted = text.match(/\+?\d[\d\s().-]{7,}\d/g) || [];
  return [text, ...extracted];
}

function phonesFromOwner(owner) {
  const fields = owner?.fields || owner || {};
  const found = new Set();
  for (const key of OWNER_PHONE_FIELDS) {
    for (const item of candidateStrings(fields[key])) {
      const normalized = normalizePhone(item);
      if (normalized) found.add(normalized);
    }
  }
  return [...found];
}

function findOwnersByPhone(owners, input) {
  const canonical = normalizePhone(input);
  if (!canonical) return { canonical: '', matches: [], valid: false };
  const matches = (owners || []).filter(owner => phonesFromOwner(owner).includes(canonical));
  return { canonical, matches, valid: true };
}

function maskPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return '';
  const visiblePrefix = Math.min(4, Math.max(2, normalized.length - 8));
  return `${normalized.slice(0, visiblePrefix)}••••${normalized.slice(-4)}`;
}

module.exports = {
  OWNER_PHONE_FIELDS,
  digits,
  normalizePhone,
  normalizeVenezuelanPhone,
  candidateStrings,
  phonesFromOwner,
  findOwnersByPhone,
  maskPhone
};
