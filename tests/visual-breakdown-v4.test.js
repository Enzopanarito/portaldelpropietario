'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../netlify/edge-functions/balance-fix.js'), 'utf8');
const release = JSON.parse(fs.readFileSync(path.join(__dirname, '../release.json'), 'utf8'));

assert.strictEqual(release.release, '2026-07-11-v6');
assert.strictEqual(release.expectedHouses, 15);
assert.strictEqual(release.breakdownPresentation, '2026-07-11-photo-v5');

const ownerStart = source.indexOf('const ownerOverride');
const visualStart = source.indexOf('const ownerBreakdownOverride');
const adminStart = source.indexOf('const adminOverride');
assert(ownerStart >= 0 && visualStart > ownerStart && adminStart > visualStart);

const ownerContract = source.slice(ownerStart, visualStart);
const visualContract = source.slice(visualStart, adminStart);

// El contrato oficial de saldos se conserva y no se recalcula desde el desglose.
assert(ownerContract.includes("var debtUsd=m(o['Saldo USD Actual']);"));
assert(ownerContract.includes("var debtBs=m(o['Saldo Bs Ref Actual']);"));
assert(ownerContract.includes("var total=m(o['Saldo Total Actual']);"));
assert(ownerContract.includes('return {linesUsd:linesUsd,linesBs:linesBs,paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total'));
assert(!ownerContract.includes("concept:'Recargo 10%"));

// La capa visual no puede leer ni escribir los campos que gobiernan la deuda.
assert(!visualContract.includes('Saldo USD Actual'));
assert(!visualContract.includes('Saldo Bs Ref Actual'));
assert(!visualContract.includes('Saldo Total Actual'));
assert(!visualContract.includes('window.calc'));
assert(!visualContract.includes('current.'));
assert(!visualContract.includes('Recargo 10% por pérdida del pronto pago'));
assert(visualContract.includes('window.renderBreakdown=draw'));
assert(visualContract.includes('function ensureHost'));
assert(visualContract.includes("document.querySelectorAll('h1,h2,h3,h4,h5,.card-title,.section-title')"));
assert(visualContract.includes("document.getElementById('breakdown')"));
assert(visualContract.includes('Deuda del Mes Anterior'));
assert(visualContract.includes('Beneficio Pronto Pago'));
assert(visualContract.includes('Total Pagado'));
assert(visualContract.includes('Costo<br>Total'));
assert(visualContract.includes('Su<br>Parte'));

const match = source.match(/const ownerBreakdownOverride = `<style[\s\S]*?<script[^>]*>\n([\s\S]*?)\n<\/script>`;/);
assert(match, 'No se pudo extraer el script del desglose visual');

function makeNode(id = '') {
  const attributes = {};
  return {
    id,
    className: '',
    innerHTML: '',
    textContent: '',
    children: [],
    parentNode: null,
    nextSibling: null,
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] || null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child) { child.parentNode = this; this.children.push(child); return child; },
    closest() { return null; },
    matches() { return false; }
  };
}

const round = n => Math.round(Number(n || 0) * 100) / 100;
const owner = {
  id: 'casa-1',
  Casa: 1,
  Alicuota: 0.07994,
  'Deuda Anterior': 65
};
const data = {
  propietarios: [owner],
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
};

function createSandbox({ legacy = false, day = '01' } = {}) {
  const breakdown = legacy ? null : makeNode('breakdown');
  const title = makeNode(legacy ? '' : 'breakdown-title');
  title.textContent = legacy ? 'Desglose de Cargos del Mes Actual' : '';
  const card = makeNode('legacy-card');
  title.closest = () => card;
  card.appendChild(title);
  let legacyHost = null;

  const nodes = legacy
    ? {}
    : { breakdown, 'breakdown-title': title };

  const document = {
    readyState: 'loading',
    body: makeNode('body'),
    getElementById(id) { return nodes[id] || null; },
    querySelector(selector) {
      if (selector.includes('data-vla-breakdown-host')) return legacyHost;
      return null;
    },
    querySelectorAll(selector) {
      if (legacy && selector.includes('h1,h2,h3')) return [title];
      return [];
    },
    createElement(tag) {
      const node = makeNode();
      if (tag === 'div' && legacy && !legacyHost) {
        legacyHost = node;
        const originalAppend = card.appendChild.bind(card);
        card.appendChild = child => {
          if (child === node) legacyHost = child;
          return originalAppend(child);
        };
      }
      return node;
    },
    addEventListener() {}
  };

  const current = { debtUsd: 85, debtBs: 221.40, total: 306.40 };
  const sandbox = {
    window: {
      money: round,
      usd: n => '$' + round(n).toFixed(2),
      monthLabel: () => 'julio de 2026',
      caracasParts: () => ({ day })
    },
    document,
    current,
    currentOwner: owner,
    all: data,
    console,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox);
  return { sandbox, breakdown, title, card, getLegacyHost: () => legacyHost, currentBefore: JSON.stringify(current) };
}

// Estructura actual: usa el contenedor #breakdown.
const modern = createSandbox({ legacy: false, day: '01' });
assert.strictEqual(typeof modern.sandbox.window.renderBreakdown, 'function');
modern.sandbox.window.renderBreakdown();
const htmlBeforeTen = modern.breakdown.innerHTML;
assert.strictEqual(modern.title.textContent, 'Desglose de Cargos para julio de 2026');
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
assert.strictEqual(JSON.stringify(modern.sandbox.current), modern.currentBefore, 'El desglose no puede modificar el saldo actual');

modern.sandbox.window.caracasParts = () => ({ day: '11' });
modern.sandbox.window.renderBreakdown();
const htmlAfterTen = modern.breakdown.innerHTML;
assert(!htmlAfterTen.includes('Beneficio Pronto Pago'));
assert(!htmlAfterTen.includes('Recargo'));
assert(htmlAfterTen.includes('Total Pagado'));
assert.strictEqual(JSON.stringify(modern.sandbox.current), modern.currentBefore, 'El saldo debe continuar intacto después del día 10');

// Estructura anterior: no existe #breakdown; la tabla debe crearse debajo del título.
const legacy = createSandbox({ legacy: true, day: '11' });
legacy.sandbox.window.renderBreakdown();
const legacyHost = legacy.getLegacyHost();
assert(legacyHost, 'Debe crear un contenedor para la versión anterior del portal');
assert(legacyHost.innerHTML.includes('VIGILANCIA'));
assert(legacyHost.innerHTML.includes('Costo<br>Total'));
assert(legacyHost.innerHTML.includes('Su<br>Parte'));
assert(!legacyHost.innerHTML.includes('Beneficio Pronto Pago'));
assert(!legacyHost.innerHTML.includes('Recargo'));
assert.strictEqual(legacy.title.textContent, 'Desglose de Cargos para julio de 2026');
assert.strictEqual(JSON.stringify(legacy.sandbox.current), legacy.currentBefore, 'La compatibilidad visual no puede modificar el saldo');

console.log('VISUAL_BREAKDOWN_V5_TESTS_OK');
