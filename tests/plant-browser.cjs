'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const engine = require('../netlify/functions/_shared/_plant_engine');
const fixture = require('../netlify/functions/_shared/_plant_fixture').createPlantFixture(new Date('2026-08-21T16:00:00Z'));

const ROOT = path.join(__dirname, '..');
const owner = fixture.owners.find(item => item.house === 3);
const ownerView = engine.ownerPlantView({ ownerId: owner.id, profiles: fixture.profiles, interventions: fixture.interventions, recognizedPayments: [], at: '2026-08-21' });
const adminView = {
  success: true, moduleVersion: 2, ownerViewContract: 'plant-owner-view-v1', readOnly: true, asset: fixture.assets[0], interventionCount: fixture.interventions.length, requests: [],
  participationSummary: engine.participationSummary({ owners: fixture.owners, profiles: fixture.profiles, at: '2026-08-21' }),
  interventions: fixture.interventions.map(item => ({ interventionId: item.interventionId, date: item.date, category: item.snapshot.category, description: item.description, amountUsd: item.snapshot.totalAmount, historicalOnly: false, source: item.source, voided: false })),
  houses: fixture.owners.map(item => { const view = engine.ownerPlantView({ ownerId: item.id, profiles: fixture.profiles, interventions: fixture.interventions, recognizedPayments: [], at: '2026-08-21' }); return { house: item.house, ownerId: item.id, ownerName: item.name, hasEmail: true, profile: engine.profileAt(fixture.profiles, item.id, '2026-08-21'), reinstatement: view.reinstatement, ownerView: view }; })
};

function ownerHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#f4f7f5;font-family:Arial;color:#10251b}.shell{max-width:1050px;margin:auto;padding:20px}.card{background:#fff;border-radius:24px}.hidden{display:none}</style><link rel="stylesheet" href="/owner-plant-v1.css"></head><body><main class="shell"><select id="userSelector"><option value="${owner.id}">Casa 3</option></select><section id="desglose" class="card" style="height:80px;margin:18px 0"></section></main><script>let currentOwner={id:${JSON.stringify(owner.id)},Casa:3};function renderUser(id){currentOwner={id:id,Casa:3}}</script><script src="/owner-plant-v1.js"></script></body></html>`;
}
function adminHtml() {
  const publicOwners = fixture.owners.map(item => ({ id: item.id, Casa: item.house, Propietario: `Propietario Casa ${item.house}` }));
  const premiumShell = `<div id="vla-premium-shell"><aside id="vla-premium-sidebar"><nav class="vla-nav"><button class="active" data-vla-target="dashboard">Dashboard</button><button data-vla-target="owners">Propietarios</button><button data-vla-target="expenses">Gastos</button><button data-vla-target="health">Salud</button></nav></aside><main id="vla-premium-main"><header><h1 id="vla-current-title">Portal Administrativo</h1></header><main id="vla-premium-content"><section id="dashboard" class="section active"></section><section id="expenses" class="section"><form id="expense-form"><input id="expense-concept"><input id="expense-amount"><div id="owners-checks"><div id="owners-list"></div></div><select id="expense-type"><option>Gasto Común</option><option>Gasto Especial</option></select><select id="expense-mode"><option>Bs BCV</option><option>USD</option></select><select id="expense-frequency"><option>Eventual</option><option>Fijo</option></select><button>Crear gasto</button></form></section><footer>VLA</footer></main></main></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="vla-admin-ui" content="premium-v1"><style>body{margin:0;background:#f4f7f5;font-family:Arial}.section{display:none}.section.active{display:block}.hidden{display:none}#vla-premium-shell{max-width:1180px;margin:auto;padding:20px}#vla-premium-sidebar .vla-nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}#vla-premium-sidebar button{padding:10px;border:0;border-radius:10px}#vla-premium-sidebar button.active{background:#12382c;color:white}</style><link rel="stylesheet" href="/admin-plant-v1.css"></head><body><div id="app"><div class="container"><nav><button class="nav" data-target="dashboard">Menú heredado</button></nav><section id="legacy" class="section active"></section><footer>VLA heredado</footer></div></div><script>let owners=${JSON.stringify(publicOwners)};window.ready=true;async function adminFetch(url,opt){const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.message||'Error');return d}function toast(){}function caracasDate(){return '2026-08-21'}async function loadAll(){return true}</script><script src="/admin-plant-v1.js"></script><script>setTimeout(function(){document.getElementById('app').innerHTML=${JSON.stringify(premiumShell)}},180)</script></body></html>`;
}
function contentType(file) { return file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'; }

let server, baseUrl, browser;
test.before(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/owner') { response.setHeader('content-type', 'text/html'); return response.end(ownerHtml()); }
    if (url.pathname === '/admin') { response.setHeader('content-type', 'text/html'); return response.end(adminHtml()); }
    if (url.pathname === '/api/vla/plant') {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') return response.end(JSON.stringify({ success: true, requestId: 'PLS-3-TEST', state: 'RECIBIDA', previewOnly: true, message: 'Solicitud recibida.' }));
      return response.end(JSON.stringify({ success: true, dataEnvironment: 'preview-fixture', ...ownerView }));
    }
    if (url.pathname === '/api/vla/admin/plant') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify(adminView)); }
    const allowed = new Set(['/owner-plant-v1.css', '/owner-plant-v1.js', '/admin-plant-v1.css', '/admin-plant-v1.js']);
    if (allowed.has(url.pathname)) { const file = path.join(ROOT, url.pathname.slice(1)); response.setHeader('content-type', contentType(file)); return response.end(fs.readFileSync(file)); }
    response.statusCode = 404; response.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`portal propietario planta funciona en ${viewport.name}`, async () => {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}/owner`);
    await page.waitForSelector('#vla-owner-plant .vla-plant-status');
    const result = await page.evaluate(() => ({ house: document.querySelector('.vla-plant-status span').textContent, history: document.querySelectorAll('.vla-plant-history-row').length, request: Boolean(document.querySelector('#vla-plant-request-form')), overflow: document.documentElement.scrollWidth - innerWidth }));
    assert.equal(result.house, 'Casa 3'); assert.equal(result.history, 3); assert.equal(result.request, true); assert(result.overflow <= 1);
    await page.screenshot({ path: `/tmp/vla-plant-owner-${viewport.name}.png`, fullPage: true }); await page.close();
  });
}

for (const viewport of [{ name: 'desktop', width: 1365, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`panel Admin planta funciona en ${viewport.name}`, async () => {
    const page = await browser.newPage({ viewport }); await page.goto(`${baseUrl}/admin`);
    await page.waitForSelector('#vla-premium-sidebar [data-vla-target="plant-management"]');
    await page.click('[data-vla-target="plant-management"]'); await page.waitForSelector('#plant-management .plant-table-wrap tbody tr');
    const result = await page.evaluate(() => ({ houses: document.querySelectorAll('#plant-management .plant-table-wrap tbody tr').length, sections: document.querySelectorAll('.plant-subnav a').length, counts: document.querySelectorAll('.plant-count-grid>div').length, asset: Boolean(document.querySelector('#plant-asset-form')), expenseIntelligence: Boolean(document.querySelector('#expense-domain')), factor: document.querySelector('[name="commonConsumptionFactor"]').value, menu: document.documentElement.dataset.vlaAdminPlantMenu, waited: document.documentElement.dataset.vlaAdminPlantWaited, title: document.querySelector('#vla-current-title').textContent, active: document.querySelector('[data-vla-target="plant-management"]').classList.contains('active'), legacyButton: Boolean(document.querySelector('[data-target="plant-management"]')), overflow: document.documentElement.scrollWidth - innerWidth }));
    assert.equal(result.houses, 15); assert.equal(result.sections, 10); assert.equal(result.counts, 6); assert.equal(result.asset, true); assert.equal(result.expenseIntelligence, true); assert.equal(result.factor, ''); assert(result.overflow <= 1);
    assert.equal(result.menu, 'premium-sidebar'); assert.equal(result.waited, 'premium-shell'); assert.equal(result.title, 'Planta eléctrica'); assert.equal(result.active, true); assert.equal(result.legacyButton, false);
    await page.click('.plant-owner-view'); await page.waitForSelector('.plant-owner-mirror .plant-mirror-banner');
    assert.match(await page.textContent('.plant-owner-mirror'), /exactamente lo que ve el propietario/i);
    await page.click('.plant-owner-mirror .plant-modal-x');
    await page.click('.plant-profile-edit'); await page.waitForSelector('.plant-manual-control #plant-projected-counts');
    assert.match(await page.textContent('.plant-manual-control'), /Confirmar cambio y notificar/i);
    await page.click('.plant-manual-control .plant-modal-x');
    await page.click('.plant-profile-simulate'); await page.waitForSelector('.plant-simulation-total');
    await page.screenshot({ path: `/tmp/vla-plant-admin-${viewport.name}.png`, fullPage: true }); await page.close();
  });
}
