'use strict';

const PREFIX = 'CURRENT_BALANCE|';
const FIELD_MONTH = 'Mes Saldo Oficial';
const FIELD_USD = 'Saldo Oficial USD Base';
const FIELD_BS = 'Saldo Oficial Bs Ref Base';
const FIELD_SURCHARGE = 'Base Recargo Oficial Bs Ref';
const FIELD_CUTOFF = 'Corte Saldo Oficial';

const CANONICAL_CONTRACT = Object.freeze({
  release: '2026-07-11-v6',
  month: '2026-07',
  revision: 20260711,
  cutoff: '2026-07-11T19:10:08.000Z',
  houses: Object.freeze({
    1:  Object.freeze({ usdCents: 8500,  bsCents: 0,      surchargeBaseCents: 0 }),
    2:  Object.freeze({ usdCents: 0,     bsCents: 0,      surchargeBaseCents: 0 }),
    3:  Object.freeze({ usdCents: 0,     bsCents: 14279,  surchargeBaseCents: 14279 }),
    4:  Object.freeze({ usdCents: 8500,  bsCents: 20127,  surchargeBaseCents: 20127 }),
    5:  Object.freeze({ usdCents: 8500,  bsCents: 0,      surchargeBaseCents: 0 }),
    6:  Object.freeze({ usdCents: 0,     bsCents: 0,      surchargeBaseCents: 0 }),
    7:  Object.freeze({ usdCents: 8500,  bsCents: 0,      surchargeBaseCents: 0 }),
    8:  Object.freeze({ usdCents: 8500,  bsCents: 0,      surchargeBaseCents: 0 }),
    9:  Object.freeze({ usdCents: -2000, bsCents: 0,      surchargeBaseCents: 0 }),
    10: Object.freeze({ usdCents: 8500,  bsCents: 19379,  surchargeBaseCents: 19379 }),
    11: Object.freeze({ usdCents: 0,     bsCents: -37889, surchargeBaseCents: 0 }),
    12: Object.freeze({ usdCents: 0,     bsCents: 9999,   surchargeBaseCents: 9999 }),
    13: Object.freeze({ usdCents: 8500,  bsCents: 19379,  surchargeBaseCents: 19379 }),
    14: Object.freeze({ usdCents: -5000, bsCents: 0,      surchargeBaseCents: 0 }),
    15: Object.freeze({ usdCents: 0,     bsCents: 16991,  surchargeBaseCents: 16991 })
  })
});

function currentMonthCaracas(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function parseKey(record) {
  const key = String(record?.fields?.Key || '');
  if (!key.startsWith(PREFIX)) return null;
  const tokens = key.split('|');
  if (tokens.length < 7) return null;
  const month = tokens[1];
  const values = {};
  for (const token of tokens.slice(2)) {
    const separator = token.indexOf('=');
    if (separator < 1) continue;
    values[token.slice(0, separator)] = token.slice(separator + 1);
  }
  const house = Number(values.HOUSE);
  const usdCents = Number(values.USD_CENTS);
  const bsCents = Number(values.BS_CENTS);
  const surchargeCents = Number(values.SURCHARGE_CENTS);
  const cutoff = String(values.CUTOFF || '');
  if (!/^\d{4}-\d{2}$/.test(month) || !Number.isInteger(house) || house < 1) return null;
  if (![usdCents, bsCents, surchargeCents].every(Number.isFinite)) return null;
  if (!Number.isFinite(Date.parse(cutoff))) return null;
  return {
    month,
    house,
    usd: usdCents / 100,
    bsRef: bsCents / 100,
    surchargeBaseBsRef: surchargeCents / 100,
    cutoff,
    revision: Number(record?.fields?.Version || 0),
    createdTime: String(record?.createdTime || ''),
    source: 'ControlVersiones'
  };
}

function canonicalSnapshots(month) {
  const byHouse = new Map();
  if (month !== CANONICAL_CONTRACT.month) return byHouse;
  for (const [houseText, values] of Object.entries(CANONICAL_CONTRACT.houses)) {
    const house = Number(houseText);
    byHouse.set(house, {
      month: CANONICAL_CONTRACT.month,
      house,
      usd: values.usdCents / 100,
      bsRef: values.bsCents / 100,
      surchargeBaseBsRef: values.surchargeBaseCents / 100,
      cutoff: CANONICAL_CONTRACT.cutoff,
      revision: CANONICAL_CONTRACT.revision,
      createdTime: CANONICAL_CONTRACT.cutoff,
      source: 'canonical-contract'
    });
  }
  return byHouse;
}

function chooseSnapshots(records = [], month = currentMonthCaracas()) {
  const byHouse = new Map();
  for (const record of records || []) {
    const parsed = parseKey(record);
    if (!parsed || parsed.month !== month) continue;
    const previous = byHouse.get(parsed.house);
    if (!previous || parsed.revision > previous.revision ||
      (parsed.revision === previous.revision && parsed.createdTime > previous.createdTime)) {
      byHouse.set(parsed.house, parsed);
    }
  }

  // Julio 2026 tiene un contrato aprobado por la administración. Se impone sobre
  // fórmulas antiguas, cachés y registros divergentes para que Público, Admin y
  // Cierre Mensual reciban exactamente los mismos 15 saldos.
  for (const [house, snapshot] of canonicalSnapshots(month)) byHouse.set(house, snapshot);
  return byHouse;
}

function attachOfficialBalances(owners = [], records = [], month = currentMonthCaracas()) {
  const snapshots = chooseSnapshots(records, month);
  return (owners || []).map(owner => {
    const fields = owner?.fields || {};
    const snapshot = snapshots.get(Number(fields.Casa));
    if (!snapshot) return owner;
    return {
      ...owner,
      fields: {
        ...fields,
        [FIELD_MONTH]: snapshot.month,
        [FIELD_USD]: snapshot.usd,
        [FIELD_BS]: snapshot.bsRef,
        [FIELD_SURCHARGE]: snapshot.surchargeBaseBsRef,
        [FIELD_CUTOFF]: snapshot.cutoff,
        'Contrato Saldo Oficial': CANONICAL_CONTRACT.release
      }
    };
  });
}

function officialControlQuery() {
  const formula = encodeURIComponent(`LEFT({Key}, ${PREFIX.length})='${PREFIX}'`);
  return `?filterByFormula=${formula}`;
}

module.exports = {
  PREFIX,
  FIELD_MONTH,
  FIELD_USD,
  FIELD_BS,
  FIELD_SURCHARGE,
  FIELD_CUTOFF,
  CANONICAL_CONTRACT,
  currentMonthCaracas,
  parseKey,
  canonicalSnapshots,
  chooseSnapshots,
  attachOfficialBalances,
  officialControlQuery
};
