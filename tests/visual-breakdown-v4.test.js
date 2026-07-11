'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../netlify/edge-functions/balance-fix.js'), 'utf8');
const release = JSON.parse(fs.readFileSync(path.join(__dirname, '../release.json'), 'utf8'));

assert.strictEqual(release.release, '2026-07-11-v6');
assert.strictEqual(release.expectedHouses, 15);
assert.strictEqual(release.breakdownPresentation, '2026-07-11-photo-v4');

const ownerStart = source.indexOf('const ownerOverride');
const visualStart = source.indexOf('const ownerBreakdownOverride');
const adminStart = source.indexOf('const adminOverride');
assert(ownerStart >= 0 && visualStart > ownerStart && adminStart > visualStart);

const ownerContract = source.slice(ownerStart, visualStart);
const visualContract = source.slice(visualStart, adminStart);

// El contrato de saldos aprobado debe conservar exactamente su fuente oficial.
assert(ownerContract.includes("var debtUsd=m(o['Saldo USD Actual']);"));
assert(ownerContract.includes("var debtBs=m(o['Saldo Bs Ref Actual']);"));
assert(ownerContract.includes("var total=m(o['Saldo Total Actual']);"));
assert(ownerContract.includes('return {linesUsd:linesUsd,linesBs:linesBs,paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total'));

// La presentación visual no puede leer ni escribir los campos que gobiernan la deuda.
assert(!visualContract.includes('Saldo USD Actual'));
assert(!visualContract.includes('Saldo Bs Ref Actual'));
assert(!visualContract.includes('Saldo Total Actual'));
assert(!visualContract.includes('window.calc'));
assert(!visualContract.includes('current.'));
assert(!visualContract.includes('Recargo 10% por pérdida del pronto pago'));
assert(visualContract.includes("window.renderBreakdown=function()"));
assert(visualContract.includes('Deuda del Mes Anterior'));
assert(visualContract.includes('Beneficio Pronto Pago'));
assert(visualContract.includes('Total Pagado'));
assert(visualContract.includes('Costo<br>Total'));
assert(visualContract.includes('Su<br>Parte'));

const match = source.match(/const ownerBreakdownOverride = `<script[^>]*>\n([\s\S]*?)\n<\/script>`;/);
assert(match, 'No se pudo extraer el script del desglose visual');

const nodes = {
  breakdown: { className: 'grid grid-cols-2', innerHTML: '' },
  'breakdown-title': { textContent: '' }
};
const round = n => Math.round(Number(n || 0) * 100) / 100;
const current = { debtUsd: 85, debtBs: 221.40, total: 306.40 };
const currentBefore = JSON.stringify(current);

const sandbox = {
  window: {
    money: round,
    usd: n => '$' + round(n).toFixed(2),
    monthLabel: () => 'julio de 2026',
    caracasParts: () => ({ day: '01' })
  },
  document: { getElementById: id => nodes[id] || null },
  current,
  currentOwner: {
    id: 'casa-1',
    Casa: 1,
    Alicuota: 0.07994,
    'Deuda Anterior': 65
  },
  all: {
    gastos: [
      { id: 'g1', fields: { Concepto: 'Vigilancia', Monto: 1000, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g2', fields: { Concepto: 'Demolición y bote de parque', Monto: 100, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g3', fields: { Concepto: 'Jardinería', Monto: 240, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g4', fields: { Concepto: 'Consumibles de limpieza', Monto: 60, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g5', fields: { Concepto: 'Camión del aseo', Monto: 60, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g6', fields: { Concepto: 'Suministro, instalación, programación de sistema de administración de acceso de portón eléctrico', Monto: 522, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { id: 'g7', fields: { Concepto: 'Gasoil', Monto: 85, 'Tipo de Gasto': 'Gasto Especial', 'Forma de Pago': 'USD', Propietarios: ['casa-1'] } }
    ],
    pagos: [
      { id: 'p1', fields: { 'Propietario que Paga': ['casa-1'], '[x] Aplicado al Cierre': false, 'Forma de Pago': 'Bs BCV', 'Equivalente USD Aplicado': 66 } },
      { id: 'p2', fields: { 'Propietario que Paga': ['casa-1'], '[x] Aplicado al Cierre': true, 'Forma de Pago': 'USD', 'Equivalente USD Aplicado': 999 } }
    ]
  },
  console
};

vm.createContext(sandbox);
vm.runInContext(match[1], sandbox);
assert.strictEqual(typeof sandbox.window.renderBreakdown, 'function');
sandbox.window.renderBreakdown();

const htmlBeforeTen = nodes.breakdown.innerHTML;
assert.strictEqual(nodes['breakdown-title'].textContent, 'Desglose de Cargos para julio de 2026');
assert(htmlBeforeTen.includes('Deuda del Mes Anterior'));
assert(htmlBeforeTen.includes('$65.00'));
assert(htmlBeforeTen.includes('VIGILANCIA'));
assert(htmlBeforeTen.includes('$1000.00'));
assert(htmlBeforeTen.includes('$79.94'));
assert(htmlBeforeTen.includes('GASOIL'));
assert(htmlBeforeTen.includes('$85.00'));
assert(htmlBeforeTen.includes('Beneficio Pronto Pago'));
assert(htmlBeforeTen.includes('- $15.84'));
assert(htmlBeforeTen.includes('Total Pagado'));
assert(htmlBeforeTen.includes('- $66.00'));
assert(!htmlBeforeTen.includes('Recargo'));
assert.strictEqual(JSON.stringify(current), currentBefore, 'El desglose no puede modificar el saldo actual');

sandbox.window.caracasParts = () => ({ day: '11' });
sandbox.window.renderBreakdown();
const htmlAfterTen = nodes.breakdown.innerHTML;
assert(!htmlAfterTen.includes('Beneficio Pronto Pago'));
assert(!htmlAfterTen.includes('Recargo'));
assert(htmlAfterTen.includes('Total Pagado'));
assert.strictEqual(JSON.stringify(current), currentBefore, 'El saldo debe continuar intacto después del día 10');

console.log('VISUAL_BREAKDOWN_V4_TESTS_OK');
