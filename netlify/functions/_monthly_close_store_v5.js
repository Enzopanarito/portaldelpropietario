'use strict';

const base = require('./_monthly_close_store');
const { attachOfficialBalances, officialControlQuery } = require('./_official_balances');

async function loadContext(month, token, baseId, counter) {
  const [context, controlRecords] = await Promise.all([
    base.loadContext(month, token, baseId, counter),
    base.getAll('ControlVersiones', officialControlQuery(), token, baseId, counter)
  ]);
  return Object.assign({}, context, {
    owners: attachOfficialBalances(context.owners || [], controlRecords || [], month),
    officialBalanceRecords: controlRecords || []
  });
}

module.exports = Object.assign({}, base, { loadContext });
