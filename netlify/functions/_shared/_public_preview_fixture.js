'use strict';

const { publicRules, defaults, caracasParts } = require('./_automation_rules');

const PREVIEW_SOURCE = 'vla-public-preview-fixture-v1';
const PREVIEW_ENVIRONMENTS = new Set(['staging', 'local', 'preview', 'deploy-preview', 'branch-deploy']);

const HOUSES = Object.freeze([
  { house: 1, aliquot: 0.08755, usd: 85, bsRef: 0 },
  { house: 2, aliquot: 0.063884, usd: 0, bsRef: 0 },
  { house: 3, aliquot: 0.06186, usd: 0, bsRef: 142.79 },
  { house: 4, aliquot: 0.06731, usd: 85, bsRef: 201.27 },
  { house: 5, aliquot: 0.07299, usd: 85, bsRef: 0 },
  { house: 6, aliquot: 0.07159, usd: 0, bsRef: 0 },
  { house: 7, aliquot: 0.06186, usd: 85, bsRef: 0 },
  { house: 8, aliquot: 0.06186, usd: 85, bsRef: 0 },
  { house: 9, aliquot: 0.06186, usd: -20, bsRef: 0 },
  { house: 10, aliquot: 0.06186, usd: 85, bsRef: 193.79 },
  { house: 11, aliquot: 0.06186, usd: 0, bsRef: -378.89 },
  { house: 12, aliquot: 0.06186, usd: 0, bsRef: 99.99 },
  { house: 13, aliquot: 0.06186, usd: 85, bsRef: 193.79 },
  { house: 14, aliquot: 0.06186, usd: -50, bsRef: 0 },
  { house: 15, aliquot: 0.07994, usd: 0, bsRef: 169.91 }
]);

function money(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function environmentName(env = process.env) {
  return String(env.VLA_DATA_ENVIRONMENT || '').trim().toLowerCase();
}

function enabled(env = process.env) {
  return PREVIEW_ENVIRONMENTS.has(environmentName(env));
}

function ownerId(house) {
  return `recPreviewHouse${String(house).padStart(2, '0')}`;
}

function buildOwner(item, now) {
  const total = money(item.usd + item.bsRef);
  const totalPayable = money(Math.max(0, item.usd) + Math.max(0, item.bsRef));
  const clock = caracasParts(now);
  const cutoff = now.toISOString();
  return {
    id: ownerId(item.house),
    Casa: item.house,
    Propietario: `Propietario de prueba Casa ${item.house}`,
    Alicuota: item.aliquot,
    'Deuda Anterior': total,
    'Deuda Anterior USD': item.usd,
    'Deuda Anterior Bs Ref': item.bsRef,
    'Cuota Base Mes': 0,
    'Total Gastos Especiales del Mes': 0,
    'Total Pagado': 0,
    'Mes Saldo Oficial': clock.monthKey,
    'Saldo Oficial USD Base': item.usd,
    'Saldo Oficial Bs Ref Base': item.bsRef,
    'Base Recargo Oficial Bs Ref': Math.max(0, item.bsRef),
    'Corte Saldo Oficial': cutoff,
    'Contrato Saldo Oficial': PREVIEW_SOURCE,
    'Estado Acceso Portón': 'Habilitado',
    'Motivo Limitación Acceso': '',
    'Última Sync MKJ': '',
    'Deuda Restante Airtable': total,
    'Recargo Airtable': 0,
    'Deuda Restante': total,
    'Recargo Aplicado': 0,
    'Saldo USD Actual': item.usd,
    'Saldo Bs Ref Actual': item.bsRef,
    'Saldo Total Actual': total,
    saldoUsd: item.usd,
    saldoBsRef: item.bsRef,
    totalPagadero: totalPayable,
    saldoNetoReferencial: total,
    saldoFavorUsd: money(Math.max(0, -item.usd)),
    saldoFavorBs: money(Math.max(0, -item.bsRef)),
    deudaVencidaUsd: 0,
    deudaVencidaBs: 0,
    mesCorrienteUsd: item.usd,
    mesCorrienteBs: item.bsRef,
    estadoMorosidad: totalPayable > 0.009 ? 'PENDIENTE' : 'SOLVENTE',
    accesoEsperado: 'Habilitado',
    balanceEngineVersion: 'vla-balance-contract-v7',
    'Deuda Vencida USD': 0,
    'Deuda Vencida Bs Ref': 0,
    'Deuda Vencida Total': 0,
    'Mes Corriente USD': item.usd,
    'Mes Corriente Bs Ref': item.bsRef,
    'Mes Corriente Total': total,
    'Cargos Mes USD': item.usd,
    'Cargos Mes Bs Ref': item.bsRef,
    'Base Pronto Pago Bs Ref': Math.max(0, item.bsRef),
    'Pago Oportuno Bs Ref': 0,
    'Pronto Pago Cumplido': item.bsRef <= 0,
    'Mes Calculo': clock.monthKey,
    'Dia Calculo': clock.day,
    'Saldo Oficial Activo': true
  };
}

function buildExpenses(now) {
  const clock = caracasParts(now);
  return [{
    id: 'recPreviewExpense1',
    fields: {
      Concepto: 'VIGILANCIA',
      Monto: 1200,
      'Tipo de Gasto': 'Gasto Común',
      Frecuencia: 'Mensual',
      Propietarios: [],
      'Forma de Pago': 'Bs BCV',
      'Mes de Aplicación': clock.monthKey,
      'Estado del Gasto': 'Activo'
    }
  }];
}

function createPayload(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  return {
    generatedAt: instant.toISOString(),
    generatedAtCaracas: new Intl.DateTimeFormat('es-VE', {
      timeZone: 'America/Caracas',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(instant),
    balanceEngineVersion: 5,
    officialBalanceSource: 'ControlVersiones',
    dataEnvironment: 'preview-fixture',
    previewFixtureVersion: PREVIEW_SOURCE,
    automation: publicRules(defaults, instant),
    propietarios: HOUSES.map(item => buildOwner(item, instant)),
    gastos: buildExpenses(instant),
    pagos: []
  };
}

function headers() {
  return {
    'X-Public-Data-Source': 'PREVIEW_FIXTURE',
    'X-Preview-Isolated': 'true',
    'X-Airtable-Calls': '0',
    'X-Balance-Engine': '5'
  };
}

module.exports = {
  PREVIEW_SOURCE,
  PREVIEW_ENVIRONMENTS,
  HOUSES,
  environmentName,
  enabled,
  createPayload,
  headers
};
