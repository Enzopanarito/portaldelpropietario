'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const css = fs.readFileSync('owner-breakdown-v7.css', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

test('el aviso publico conserva contraste alto en modo oscuro para todos los niveles', () => {
  assert.match(index, /id="public-notice"/);
  assert.match(css, /html\.dark #public-notice\{[^}]*background:#0f172a!important;[^}]*color:#f8fafc!important;/);
  assert.match(css, /html\.dark #public-notice\.bg-sky-50\{background:#082f49!important;border-color:#38bdf8!important;/);
  assert.match(css, /html\.dark #public-notice\.bg-amber-50\{background:#451a03!important;border-color:#fbbf24!important;/);
  assert.match(css, /html\.dark #public-notice\.bg-violet-50\{background:#2e1065!important;border-color:#c4b5fd!important;/);
  assert.match(css, /html\.dark #public-notice\.bg-red-50\{background:#450a0a!important;border-color:#f87171!important;/);
  assert.match(css, /html\.dark #public-notice b\{color:#f8fafc!important;opacity:1!important;?\}/);
  assert.match(css, /html\.dark #public-notice p\{color:#e2e8f0!important;opacity:1!important;?\}/);
});
