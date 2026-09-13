'use strict';

const OWNER_PHONE_FIELDS = Object.freeze([
  'Telefono', 'Teléfono', 'WhatsApp', 'Telefono WhatsApp', 'Teléfono WhatsApp',
  'Telefono 2', 'Teléfono 2', 'Telefono Alterno', 'Teléfono Alterno'
]);

function clean(value) { return String(value ?? '').trim(); }
function digits(value) { return clean(value).replace(/\D/g, ''); }

function normalizeVenezuelanPhone(value) {
  let raw = digits(value);
  if (raw.startsWith('00')) raw = raw.slice(2);
  let national = raw;
  if (raw.startsWith('58')) national = raw.slice(2);
  else if (raw.startsWith('0')) national = raw.slice(1);
  if (national.length !== 10 || national[0] !== '4') return '';
  return `+58${national}`;
}

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
      const normalized = normalizeVenezuelanPhone(item);
      if (normalized) found.add(normalized);
    }
  }
  return [...found];
}

function findOwnersByPhone(owners, input) {
  const canonical = normalizeVenezuelanPhone(input);
  if (!canonical) return { canonical: '', matches: [], valid: false };
  const matches = (owners || []).filter(owner => phonesFromOwner(owner).includes(canonical));
  return { canonical, matches, valid: true };
}

function maskPhone(value) {
  const normalized = normalizeVenezuelanPhone(value);
  if (!normalized) return '';
  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

module.exports = {
  OWNER_PHONE_FIELDS,
  digits,
  normalizeVenezuelanPhone,
  candidateStrings,
  phonesFromOwner,
  findOwnersByPhone,
  maskPhone
};
