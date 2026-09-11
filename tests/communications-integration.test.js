'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function edge(name) {
  const context = { module: { exports: {} }, Response, Headers };
  vm.runInNewContext(source(`netlify/edge-functions/${name}.js`).replace('export default', 'module.exports ='), context);
  return context.module.exports;
}

async function adminResponse() {
  const names = [...source('netlify.toml').matchAll(/\[\[edge_functions\]\]\s*function = "([^"]+)"\s*path = "\/admin\*"/g)].map(x => x[1]);
  const run = index => index === names.length
    ? new Response(source('admin.html'), { headers: { 'content-type': 'text/html' } })
    : edge(names[index])(new Request('https://vla.test/admin.html'), { next: () => run(index + 1) });
  return run(0);
}

test('pipeline admin real inserta ambos cuadros una vez en una sección separada del control automático', async () => {
  const response = await adminResponse();
  const html = await response.text();
  assert.equal(response.headers.get('x-vla-communications'), 'admin-v1');
  for (const id of ['vla-communications', 'com-body', 'notice-body', 'notice-publish']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
  const begin = html.indexOf("<section id='whatsapp-control'");
  const end = html.indexOf('</section>', begin);
  assert.ok(html.indexOf('id="vla-communications"') > begin);
  assert.ok(html.indexOf('id="vla-communications"') > end);
  assert.match(html, /<section id="communications" class="section">/);
  for (const id of ['wa-mode', 'wa-save-config', 'wa-refresh']) assert.ok(html.includes(`id='${id}'`), id);
  const twice = await edge('admin-communications')(null, { next: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(await twice.text(), html);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});

function memoryStore() {
  const records = new Map();
  let version = 0;
  const atomic = {
    async getWithMetadata(key) { const row = records.get(key); return row ? structuredClone(row) : null; },
    async setJSON(key, data, options) {
      const row = records.get(key);
      if ((options.onlyIfNew && row) || (options.onlyIfMatch && row?.etag !== options.onlyIfMatch)) return { modified: false };
      records.set(key, { data: structuredClone(data), etag: String(++version) });
      return { modified: true };
    }
  };
  const context = { module: { exports: {} }, require: () => ({ getAtomicStore: () => atomic, connectLambdaEvent() {} }) };
  vm.runInNewContext(source('netlify/functions/_shared/_communications_store.js'), context);
  return context.module.exports;
}

test('50 reclamaciones concurrentes tienen un único ganador y no reinician trabajos enviados', async () => {
  const store = memoryStore();
  await store.createJob({ jobId: 'COM-20260909-ABCDEF123456', status: 'QUEUED' });
  const results = await Promise.all(Array.from({ length: 50 }, () => store.claimJob('COM-20260909-ABCDEF123456')));
  assert.equal(results.filter(x => x.claimed).length, 1);
  assert.equal((await store.readJob('COM-20260909-ABCDEF123456')).status, 'RUNNING');
  for (const status of ['DONE', 'PARTIAL', 'FAILED_SAFE', 'DELIVERY_STARTED']) {
    await store.updateJob('COM-20260909-ABCDEF123456', { status });
    assert.equal((await store.claimJob('COM-20260909-ABCDEF123456')).claimed, false);
  }
});

test('dos invocaciones del despachador no duplican correo ni WhatsApp', async () => {
  const store = memoryStore();
  const jobId = 'COM-20260909-ABCDEF123456';
  await store.createJob({ jobId, status: 'QUEUED', subject: 'Gasoil', body: 'Compra registrada.', ownerIds: ['recABCDEFGHIJKLMN'], channels: ['email', 'whatsapp'] });
  let mail = 0, whatsapp = 0;
  const exports = {};
  const dependencies = {
    './_auth': { requireAdmin: () => ({ ok: true }) },
    './_mailer': { sendMail: async () => { mail++; return { sent: true }; } },
    './_security_utils': { safeDisplayText: x => x },
    './_communications_contract': require('../netlify/functions/_shared/_communications_contract'),
    './_communications_store': store,
    './_communications_catalog': { loadCatalog: async () => ({ owners: [{ id: 'recABCDEFGHIJKLMN', Casa: 1, Propietario: 'Prueba', Email: 'fixture@example.invalid' }], expenses: [] }) },
    './_communications_relay': { relayCommunication: async () => { whatsapp++; return { queued: { accepted: true } }; } }
  };
  vm.runInNewContext(source('netlify/functions/_shared/_communications_dispatch_handler.js'), { exports, require: name => { assert.ok(dependencies[name], name); return dependencies[name]; } });
  const event = { httpMethod: 'POST', body: JSON.stringify({ jobId }) };
  const results = await Promise.all([exports.handler(event), exports.handler(event)]);
  assert.ok(results.every(x => x.statusCode === 200));
  assert.equal(mail, 1);
  assert.equal(whatsapp, 1);
  assert.equal((await store.readJob(jobId)).status, 'DELIVERY_STARTED');
  await exports.handler(event);
  assert.equal(mail, 1);
  assert.equal(whatsapp, 1);
});

test('aviso desaparece al vencer aun con la página abierta y no bloquea si falla su API', async () => {
  const line = source('index.html').split('\n').find(x => x.startsWith('async function loadPublicNotice()'));
  const classes = new Set(['hidden']);
  const host = { innerHTML: '', classList: { add: x => classes.add(x) }, querySelector: () => ({ textContent: '' }) };
  let expiry, delay;
  const context = {
    document: { getElementById: () => host },
    fetch: async () => ({ json: async () => ({ notice: { title: 'Aviso', body: 'Contenido', expiresAt: new Date(Date.now() + 60000).toISOString() } }) }),
    setTimeout: (callback, ms) => { expiry = callback; delay = ms; }, clearTimeout() {}
  };
  vm.runInNewContext(line, context);
  await context.loadPublicNotice();
  assert.ok(host.innerHTML.includes('<b'));
  assert.ok(delay > 0 && delay <= 60000);
  expiry();
  assert.equal(host.innerHTML, '');
  assert.ok(classes.has('hidden'));
  context.fetch = async () => { throw new Error('sin red'); };
  await assert.doesNotReject(context.loadPublicNotice());
});
