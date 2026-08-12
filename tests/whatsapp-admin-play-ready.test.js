'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const controlEdge = () => read('netlify/edge-functions/admin-whatsapp-control.js');
const relinkEdge = () => read('netlify/edge-functions/admin-whatsapp-relink.js');
const relay = () => read('netlify/functions/whatsapp-control.js');
const relinkRelay = () => read('netlify/functions/whatsapp-relink.js');

test('Admin WhatsApp es mobile-first y evita una tabla imposible en iPhone', () => {
  const ui = controlEdge();
  assert.match(ui, /grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3/);
  assert.match(ui, /grid grid-cols-1 xl:grid-cols-2 gap-6/);
  assert.match(ui, /grid grid-cols-1 sm:grid-cols-2 gap-3/);
  assert.match(ui, /sm:hidden space-y-3/);
  assert.match(ui, /hidden sm:block overflow-x-auto/);
  assert.match(ui, /min-h-12/);
  assert.match(ui, /break-words/);
  assert.doesNotMatch(ui, /min-w-\[[5-9][0-9]{2}px\]|w-\[[5-9][0-9]{2}px\]/);
});

test('flujo QR de re-vinculación se apila en móvil y mantiene objetivos táctiles', () => {
  const ui = relinkEdge();
  assert.match(ui, /flex flex-col lg:flex-row/);
  assert.match(ui, /grid grid-cols-1 lg:grid-cols-\[minmax\(0,320px\)_1fr\]/);
  assert.match(ui, /max-w-full w-\[280px\] h-auto/);
  assert.match(ui, /w-full lg:w-auto/);
  assert.match(ui, /w-full sm:w-auto/);
  assert.match(ui, /min-h-12/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});

test('Pausar y Reanudar usan acciones explícitas y reanudan únicamente AUTOMÁTICO', () => {
  const backend = relay();
  const ui = controlEdge();
  assert.match(backend, /if \(action === 'pause'\) payload = \{ mode: 'paused' \}/);
  assert.match(backend, /if \(action === 'resume'\) payload = \{ mode: 'automatic' \}/);
  assert.match(ui, /simple\('pause','Automatización pausada\.'/);
  assert.match(ui, /simple\('resume','Automatización reanudada\.'/);
  assert.match(ui, /cfg\.mode==='automatic'/);
});

test('RUN NOW conserva doble protección: confirmación y ventana servidor', () => {
  const backend = relay();
  assert.match(backend, /body\.confirm !== 'ENVIAR'/);
  assert.match(backend, /!inAllowedWindowAt\(\)/);
  assert.match(backend, /08:00 y 20:59/);
  assert.match(controlEdge(), /windowState\.allowed===false/);
});

test('re-vinculación no expone agente local, token ni QR persistente', () => {
  const all = relinkEdge() + '\n' + relinkRelay();
  assert.doesNotMatch(all, /WA_AGENT_TOKEN|127\.0\.0\.1:8787|whatsapp-agent:8787/);
  assert.doesNotMatch(relinkEdge(), /localStorage|sessionStorage/);
  assert.match(relinkRelay(), /Cache-Control.*no-store/si);
  assert.match(relinkRelay(), /sameOrigin\(event\)/);
});

test('Play Ready no introduce dependencias financieras en el control WhatsApp', () => {
  const all = controlEdge() + '\n' + relinkEdge() + '\n' + relay() + '\n' + relinkRelay();
  assert.doesNotMatch(all, /AIRTABLE_API_TOKEN|PAYMENT_PROOF_ENCRYPTION_KEY|monthly-close|admin-manual-payment|process-payment-report|mkj/i);
});
