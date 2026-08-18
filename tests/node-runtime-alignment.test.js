'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('Netlify build environment is pinned to Node 24', () => {
  const source = read('netlify.toml');
  assert.match(source, /\[build\.environment\][\s\S]*?NODE_VERSION\s*=\s*"24"/);
  assert.doesNotMatch(source, /NODE_VERSION\s*=\s*"22"/);
});

test('production deploy uses Node 24 for runner and Lambda runtime', () => {
  const source = read('.github/workflows/netlify-production.yml');
  assert.match(source, /node-version:\s*['"]24['"]/);
  assert.match(source, /AWS_LAMBDA_JS_RUNTIME:\s*nodejs24\.x/);
});

test('validation workflow uses Node 24', () => {
  const source = read('.github/workflows/validate.yml');
  assert.match(source, /node-version:\s*['"]24['"]/);
});

test('package engine range accepts Node 24', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.engines?.node, '>=22 <25');
});
