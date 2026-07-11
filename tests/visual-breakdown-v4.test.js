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

const visualStart = source.indexOf('const ownerBreakdownOverride');
const adminStart = source.indexOf('const adminOverride');
const visual = source.slice(visualStart, adminStart);
assert(visualStart >= 0 && adminStart > visualStart);
assert(!visual.includes('Saldo USD Actual'));
assert(!visual.includes('Saldo Bs Ref Actual'));
assert(!visual.includes('Saldo Total Actual'));
assert(!visual.includes('window.calc'));
assert(!visual.includes('Recargo 10% por pérdida del pronto pago'));
assert(visual.includes('window.renderBreakdown=draw'));
assert(visual.includes('function ensureHost'));
assert(visual.includes("document.querySelectorAll('h1,h2,h3,h4,h5,.card-title,.section-title')"));
assert(visual.includes("document.getElementById('breakdown')"));
assert(visual.includes('Deuda del Mes Anterior'));
assert(visual.includes('Beneficio Pronto Pago'));
assert(visual.includes('Total Pagado'));
assert(visual.includes('Costo<br>Total'));
assert(visual.includes('Su<br>Parte'));

const match = source.match(/const ownerBreakdownOverride = `<style[\s\S]*?<script[^>]*>\n([\s\S]*?)\n<\/script>`;/);
assert(match, 'No se pudo extraer el script visual');

function node(id = '') {
  const attrs = {};
  return {
    id, className: '', innerHTML: '', textContent: '', children: [], parentNode: null,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] || null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child) { child.parentNode = this; this.children.push(child); return child; },
    closest() { return null; },
    matches() { return false; }
  };
}

function run(legacy, day) {
  const owner = { id: 'casa-1', Casa: 1, Alicuota: 0.07994, 'Deuda Anterior': 65 };
  const data = {
    propietarios: [owner],
    gastos: [
      { fields: { Concepto: 'Vigilancia', Monto: 1000, 'Tipo de Gasto': 'Gasto Común', 'Forma de Pago': 'Bs BCV', Propietarios: [] } },
      { fields: { Concepto: 'Gasoil', Monto: 85, 'Tipo de Gasto': 'Gasto Especial', 'Forma de Pago': 'USD', Propietarios: ['casa-1'] } }
    ],
    pagos: [{ fields: { 'Propietario que Paga': ['casa-1'], '[x] Aplicado al Cierre': false, 'Equivalente USD Aplicado': 66 } }]
  };
  const title = node(legacy ? '' : 'breakdown-title');
  title.textContent = legacy ? 'Desglose de Cargos del Mes Actual' : '';
  const card = node('card');
  title.closest = () => card;
  card.appendChild(title);
  const modernHost = legacy ? null : node('breakdown');
  let generatedHost = null;
  const nodes = legacy ? {} : { breakdown: modernHost, 'breakdown-title': title };
  const document = {
    readyState: 'loading', body: node('body'),
    getElementById(id) { return nodes[id] || null; },
    querySelector(selector) { return selector.includes('data-vla-breakdown-host') ? generatedHost : null; },
    querySelectorAll(selector) { return legacy && selector.includes('h1,h2,h3') ? [title] : []; },
    createElement(tag) { const n = node(); if (legacy && tag === 'div' && !generatedHost) generatedHost = n; return n; },
    addEventListener() {}
  };
  const current = { total: 306.40, debtUsd: 85, debtBs: 221.40 };
  const before = JSON.stringify(current);
  const sandbox = {
    window: { money: n => Math.round(Number(n || 0) * 100) / 100, usd: n => '$' + Number(n || 0).toFixed(2), monthLabel: () => 'julio de 2026', caracasParts: () => ({ day }) },
    document, currentOwner: owner, all: data, current, console,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox);
  sandbox.window.renderBreakdown();
  const host = modernHost || generatedHost;
  assert(host, 'Debe existir un contenedor de desglose');
  assert(host.innerHTML.includes('VIGILANCIA'));
  assert(host.innerHTML.includes('$1000.00'));
  assert(host.innerHTML.includes('$79.94'));
  assert(host.innerHTML.includes('GASOIL'));
  assert(host.innerHTML.includes('Total Pagado'));
  assert(!host.innerHTML.includes('Recargo'));
  assert.strictEqual(JSON.stringify(current), before, 'El desglose no puede modificar saldos');
  return { host, title };
}

const beforeTen = run(false, '01');
assert(beforeTen.host.innerHTML.includes('Beneficio Pronto Pago'));
assert(beforeTen.host.innerHTML.includes('- $7.99'));
assert.strictEqual(beforeTen.title.textContent, 'Desglose de Cargos para julio de 2026');

const afterTen = run(true, '11');
assert(!afterTen.host.innerHTML.includes('Beneficio Pronto Pago'));
assert(afterTen.host.innerHTML.includes('VIGILANCIA'));
assert(afterTen.host.innerHTML.includes('Costo<br>Total'));
assert(afterTen.host.innerHTML.includes('Su<br>Parte'));

console.log('VISUAL_BREAKDOWN_V5_TESTS_OK');
