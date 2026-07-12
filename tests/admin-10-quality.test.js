'use strict';

const fs = require('fs');
const assert = require('assert');

function read(path) { return fs.readFileSync(path, 'utf8'); }

const assets = read('netlify/edge-functions/admin-premium-assets.js');
const css = read('admin-accessibility-v2.css');
const runtime = read('admin-accessibility-v2.js');
const manualPayment = read('netlify/functions/admin-manual-payment.js');
const reportPayment = read('netlify/functions/process-payment-report.js');

assert.match(assets, /admin-accessibility-v2\.css/, 'El admin debe cargar la hoja de accesibilidad.');
assert.match(assets, /admin-accessibility-v2\.js/, 'El admin debe cargar la semántica visual de saldos.');
assert.match(assets, /premium-v2-accessible/, 'La respuesta debe identificar la versión accesible.');

assert.match(css, /font-size:15px!important/, 'Las tablas deben tener una tipografía legible.');
assert.match(css, /\.vla-donut\{width:190px;height:190px\}/, 'Los gráficos deben crecer.');
assert.match(css, /\.vla-money\.is-solvent/, 'Debe existir un estado visual verde.');
assert.match(css, /\.vla-money\.is-debt/, 'Debe existir un estado visual rojo.');
assert.match(css, /focus-visible/, 'Debe existir foco de teclado accesible.');

assert.match(runtime, /MutationObserver/, 'Los datos cargados dinámicamente deben decorarse.');
assert.match(runtime, /parseNumber/, 'Los montos deben interpretarse de forma controlada.');
assert.match(runtime, /vlaRefreshAccessibility/, 'Debe existir una actualización manual verificable.');

for (const [name, source] of [['pago manual', manualPayment], ['reporte de pago', reportPayment]]) {
  assert.match(source, /ensureFinancialWritesAllowed/, `${name}: debe respetar el bloqueo financiero.`);
  const lockPosition = source.indexOf('ensureFinancialWritesAllowed()');
  const firstWrite = Math.min(...['airtableCreateRecord(', 'airtablePatchRecord(']
    .map(token => source.indexOf(token, lockPosition + 1))
    .filter(position => position >= 0));
  assert(lockPosition >= 0 && firstWrite > lockPosition, `${name}: el bloqueo debe evaluarse antes de escribir.`);
}

console.log('Admin 10/10: accesibilidad, semántica visual y bloqueo financiero verificados.');
