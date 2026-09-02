'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { OWNER_BALANCE_CONTRACT } = require('../netlify/functions/_shared/_public_financial_contract');

function loadEdgeHandler(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  let source = fs.readFileSync(filename, 'utf8');
  const marker = 'export default async';
  assert(source.includes(marker), `${relativePath}: export default no encontrado`);
  source = source.replace(marker, 'globalThis.__edgeHandler = async');
  const sandbox = {
    console,
    Headers,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename });
  assert.strictEqual(typeof sandbox.__edgeHandler, 'function', `${relativePath}: handler no cargado`);
  return sandbox.__edgeHandler;
}

async function renderEdge(relativePath, pathname = '/') {
  const handler = loadEdgeHandler(relativePath);
  const request = { url: `https://example.test${pathname}` };
  const context = {
    next: async () => new Response('<!doctype html><html><head></head><body><main>BASE</main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  };
  const response = await handler(request, context);
  return { response, html: await response.text() };
}

function scriptById(html, idPrefix) {
  const pattern = new RegExp(`<script[^>]+id=["'](${idPrefix}[^"']*)["'][^>]*>([\\s\\S]*?)<\\/script>`);
  const match = html.match(pattern);
  assert(match, `Script ${idPrefix} no encontrado en HTML final`);
  return { id: match[1], source: match[2] };
}

(async () => {
  const pwa = await renderEdge('netlify/edge-functions/pwa-head.js', '/');
  const bcv = scriptById(pwa.html, 'vla-bcv-official-logo-fix');
  assert.doesNotThrow(() => new vm.Script(bcv.source), 'El script visual del BCV debe ser JavaScript válido');
  assert.strictEqual(pwa.response.headers.get('x-vla-balance-contract'), OWNER_BALANCE_CONTRACT);
  assert.strictEqual(pwa.response.headers.get('x-vla-breakdown-presentation'), 'owner-breakdown-v7');
  assert(!pwa.html.includes('vla-visual-breakdown-2026-07-11-photo-v6'), 'No debe inyectarse el desglose histórico');

  console.log('INJECTED_BROWSER_SCRIPTS_OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
