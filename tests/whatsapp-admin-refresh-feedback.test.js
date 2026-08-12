'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const edgePath = path.join(__dirname, '..', 'netlify', 'edge-functions', 'admin-whatsapp-control.js');

test('Actualizar WhatsApp muestra feedback visible y bloquea doble clic', () => {
  const edge = fs.readFileSync(edgePath, 'utf8');
  assert.match(edge, /refreshWithFeedback/);
  assert.match(edge, /button\.disabled=true/);
  assert.match(edge, /Actualizando…/);
  assert.match(edge, /Actualizado/);
  assert.match(edge, /❌ Error/);
  assert.match(edge, /button\.disabled=false/);
  assert.match(edge, /onclick=refreshWithFeedback/);
});
