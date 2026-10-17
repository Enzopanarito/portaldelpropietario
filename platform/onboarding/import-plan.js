'use strict';

const { parseFixed, formatFixed } = require('../core/fixed-decimal');
const { normalizeCurrency } = require('../core/financial-ledger');

const UNIT_TYPES = new Set(['house','apartment','office','commercial','parking','storage','parcel','residential','other']);
const STRUCTURE_TYPES = new Set(['tower','block','sector','stage','floor','wing','cluster','other']);

function issue(code, message, row, field = null) {
  return Object.freeze({ code, message, row, field });
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Invalid email'), { code: 'IMPORT_EMAIL_INVALID' });
  }
  return email;
}

function normalizeCode(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function openingColumn(currency) {
  return `opening_${currency}`;
}

function createImportPlan(rows, { currencies, defaultUnitType = 'apartment' } = {}) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('rows must be an array'), { code: 'IMPORT_ROWS_REQUIRED' });
  const allowedCurrencies = [...new Set((currencies || []).map(normalizeCurrency))];
  if (!allowedCurrencies.length) throw Object.assign(new Error('currencies are required'), { code: 'IMPORT_CURRENCIES_REQUIRED' });
  if (!UNIT_TYPES.has(defaultUnitType)) throw Object.assign(new Error('Invalid defaultUnitType'), { code: 'IMPORT_DEFAULT_UNIT_TYPE_INVALID' });

  const errors = [];
  const warnings = [];
  const units = [];
  const structuresByKey = new Map();
  const peopleByKey = new Map();
  const memberships = [];
  const openingEntries = [];
  const seenUnits = new Map();
  const totals = new Map(allowedCurrencies.map(currency => [currency, 0n]));

  rows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const row = raw && typeof raw === 'object' ? raw : {};
    const unitCode = normalizeCode(row.unit_code);
    if (!unitCode) {
      errors.push(issue('UNIT_CODE_REQUIRED', 'unit_code is required', rowNumber, 'unit_code'));
      return;
    }
    const duplicateAt = seenUnits.get(unitCode.toLowerCase());
    if (duplicateAt) {
      errors.push(issue('UNIT_CODE_DUPLICATE', `unit_code ${unitCode} duplicates row ${duplicateAt}`, rowNumber, 'unit_code'));
      return;
    }
    seenUnits.set(unitCode.toLowerCase(), rowNumber);

    const unitType = String(row.unit_type || defaultUnitType).trim().toLowerCase();
    if (!UNIT_TYPES.has(unitType)) {
      errors.push(issue('UNIT_TYPE_INVALID', `Unsupported unit_type ${unitType}`, rowNumber, 'unit_type'));
      return;
    }

    let coefficient = null;
    if (String(row.ownership_coefficient || '').trim()) {
      try {
        const scaled = parseFixed(row.ownership_coefficient, 10);
        if (scaled < 0n) throw new Error('negative');
        coefficient = formatFixed(scaled, 10);
      } catch (_) {
        errors.push(issue('OWNERSHIP_COEFFICIENT_INVALID', 'ownership_coefficient must be a non-negative decimal', rowNumber, 'ownership_coefficient'));
        return;
      }
    }

    const structureCode = normalizeCode(row.structure_code);
    let structureKey = null;
    if (structureCode) {
      const structureType = String(row.structure_type || 'other').trim().toLowerCase();
      if (!STRUCTURE_TYPES.has(structureType)) {
        errors.push(issue('STRUCTURE_TYPE_INVALID', `Unsupported structure_type ${structureType}`, rowNumber, 'structure_type'));
        return;
      }
      structureKey = `${structureType}:${structureCode.toLowerCase()}`;
      const existing = structuresByKey.get(structureKey);
      const candidate = Object.freeze({
        structureKey,
        code: structureCode,
        displayName: normalizeCode(row.structure_name) || structureCode,
        structureType
      });
      if (existing && (existing.code !== candidate.code || existing.displayName !== candidate.displayName || existing.structureType !== candidate.structureType)) {
        errors.push(issue('STRUCTURE_CONFLICT', `Structure ${structureCode} is described inconsistently`, rowNumber, 'structure_code'));
        return;
      }
      if (!existing) structuresByKey.set(structureKey, candidate);
    }

    const unitKey = `unit:${unitCode.toLowerCase()}`;
    units.push(Object.freeze({
      unitKey,
      code: unitCode,
      displayName: normalizeCode(row.unit_name) || unitCode,
      unitType,
      structureKey,
      ownershipCoefficient: coefficient
    }));

    const ownerName = normalizeCode(row.owner_name);
    if (!ownerName) {
      warnings.push(issue('OWNER_MISSING', `Unit ${unitCode} has no owner_name`, rowNumber, 'owner_name'));
    } else {
      const personKey = normalizeCode(row.person_key) || `owner:${unitCode.toLowerCase()}`;
      let email = '';
      try {
        email = normalizeEmail(row.owner_email);
      } catch (_) {
        errors.push(issue('OWNER_EMAIL_INVALID', `Invalid owner_email for ${unitCode}`, rowNumber, 'owner_email'));
        return;
      }
      const candidate = Object.freeze({
        personKey,
        displayName: ownerName,
        email,
        phone: String(row.owner_phone || '').trim(),
        documentType: String(row.document_type || '').trim(),
        documentNumber: String(row.document_number || '').trim()
      });
      const existing = peopleByKey.get(personKey);
      if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
        errors.push(issue('PERSON_KEY_CONFLICT', `person_key ${personKey} maps to different owner data`, rowNumber, 'person_key'));
        return;
      }
      if (!existing) peopleByKey.set(personKey, candidate);
      memberships.push(Object.freeze({ unitKey, personKey, role: 'owner', isPrimary: true }));
    }

    for (const currency of allowedCurrencies) {
      const field = openingColumn(currency);
      const rawAmount = String(row[field] || '').trim();
      if (!rawAmount) continue;
      try {
        const amount = parseFixed(rawAmount);
        if (amount === 0n) continue;
        openingEntries.push(Object.freeze({
          unitKey,
          currencyCode: currency,
          amount: formatFixed(amount),
          entryKind: 'opening',
          sourceLineKey: `${unitCode}:${currency}`
        }));
        totals.set(currency, totals.get(currency) + amount);
      } catch (error) {
        errors.push(issue(error.code || 'OPENING_BALANCE_INVALID', `Invalid ${field} for ${unitCode}`, rowNumber, field));
      }
    }
  });

  const openingTotals = allowedCurrencies.map(currency => Object.freeze({
    currencyCode: currency,
    balance: formatFixed(totals.get(currency)),
    amountDue: formatFixed(totals.get(currency) > 0n ? totals.get(currency) : 0n),
    netCredit: formatFixed(totals.get(currency) < 0n ? -totals.get(currency) : 0n)
  }));

  return Object.freeze({
    schemaVersion: 1,
    ready: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    structures: Object.freeze([...structuresByKey.values()]),
    units: Object.freeze(units),
    people: Object.freeze([...peopleByKey.values()]),
    memberships: Object.freeze(memberships),
    openingEntries: Object.freeze(openingEntries),
    reconciliation: Object.freeze({
      inputRows: rows.length,
      acceptedUnits: units.length,
      uniquePeople: peopleByKey.size,
      openingTotals: Object.freeze(openingTotals)
    })
  });
}

module.exports = {
  UNIT_TYPES,
  STRUCTURE_TYPES,
  openingColumn,
  createImportPlan
};
