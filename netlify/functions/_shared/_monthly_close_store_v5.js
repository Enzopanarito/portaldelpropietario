'use strict';

const base = require('./_monthly_close_store');
const { attachOfficialBalances, officialControlQuery } = require('./_official_balances');
const { filterClosingExpenses } = require('./_expense_lifecycle');
const { mergeConfig } = require('./_automation_rules');

function snapshotQuery(month) {
  const prefix = `AUDITORIA|${month}|`;
  const formula = encodeURIComponent(`FIND('${prefix}', {Concepto})`);
  const fields = ['Concepto', 'Monto Cargado', 'Propietario', 'Fecha']
    .map(field => `fields%5B%5D=${encodeURIComponent(field)}`).join('&');
  return `?filterByFormula=${formula}&${fields}`;
}

async function loadContext(month, token, baseId, counter) {
  const [context, controlRecords, configRecords, snapshotRecords] = await Promise.all([
    base.loadContext(month, token, baseId, counter),
    base.getAll('ControlVersiones', officialControlQuery(), token, baseId, counter),
    base.getAll('Configuración', '?maxRecords=1', token, baseId, counter),
    base.getAll('Historial de Cargos', snapshotQuery(month), token, baseId, counter)
  ]);
  return Object.assign({}, context, {
    owners: attachOfficialBalances(context.owners || [], controlRecords || [], month),
    expenses: filterClosingExpenses(context.expenses || [], month),
    officialBalanceRecords: controlRecords || [],
    automationRules: mergeConfig(configRecords[0] || {}),
    snapshotRecords: snapshotRecords || []
  });
}

module.exports = Object.assign({}, base, { loadContext, snapshotQuery });
