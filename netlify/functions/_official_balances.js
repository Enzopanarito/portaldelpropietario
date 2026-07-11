'use strict';

const PREFIX = 'CURRENT_BALANCE|';
const FIELD_MONTH = 'Mes Saldo Oficial';
const FIELD_USD = 'Saldo Oficial USD Base';
const FIELD_BS = 'Saldo Oficial Bs Ref Base';
const FIELD_SURCHARGE = 'Base Recargo Oficial Bs Ref';
const FIELD_CUTOFF = 'Corte Saldo Oficial';

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
    createdTime: String(record?.createdTime || '')
  };
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
        [FIELD_CUTOFF]: snapshot.cutoff
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
  currentMonthCaracas,
  parseKey,
  chooseSnapshots,
  attachOfficialBalances,
  officialControlQuery
};
