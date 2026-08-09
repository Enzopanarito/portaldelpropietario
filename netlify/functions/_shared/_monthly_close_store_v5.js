'use strict';

const base = require('./_monthly_close_store');
const { attachOfficialBalances, officialControlQuery } = require('./_official_balances');
const { filterClosingExpenses } = require('./_expense_lifecycle');
const { mergeConfig } = require('./_automation_rules');

async function loadContext(month, token, baseId, counter) {
  const [context, controlRecords,configRecords] = await Promise.all([
    base.loadContext(month, token, baseId, counter),
    base.getAll('ControlVersiones', officialControlQuery(), token, baseId, counter),
    base.getAll('Configuración','?maxRecords=1',token,baseId,counter)
  ]);
  return Object.assign({}, context, {
    owners: attachOfficialBalances(context.owners || [], controlRecords || [], month),
    expenses:filterClosingExpenses(context.expenses||[],month),
    officialBalanceRecords: controlRecords || [],
    automationRules:mergeConfig(configRecords[0]||{})
  });
}

module.exports = Object.assign({}, base, { loadContext });
