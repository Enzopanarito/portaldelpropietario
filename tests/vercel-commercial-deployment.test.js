'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appRoot = path.join(root, 'apps', 'platform-web');
const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const runtime = fs.readFileSync(path.join(appRoot, 'lib', 'runtime.js'), 'utf8');
const health = fs.readFileSync(path.join(appRoot, 'app', 'api', 'health', 'route.js'), 'utf8');
const architecture = fs.readFileSync(path.join(root, 'docs', 'VERCEL_REGIONAL_DEPLOYMENT_ARCHITECTURE.md'), 'utf8');

test('commercial web shell is Vercel/Next and contains no Netlify runtime dependency', () => {
  assert.equal(pkg.dependencies.next, '16.4.2');
  assert.equal(pkg.dependencies.react, '19.3.1');
  assert.equal(pkg.dependencies['react-dom'], '19.3.1');
  assert.equal(pkg.dependencies['@supabase/supabase-js'], '2.118.0');
  assert.equal(pkg.dependencies['@netlify/blobs'], undefined);
  assert.doesNotMatch(runtime + health, /netlify/i);
});

test('commercial topology uses one regional Vercel app and dedicated customer Data Planes', () => {
  assert.match(architecture, /Do not create one Vercel project per condominium/i);
  assert.match(architecture, /dedicated Supabase project/i);
  assert.match(architecture, /Control Plane/i);
});

test('runtime fails closed if server secrets are marked public', () => {
  assert.match(runtime, /NEXT_PUBLIC_/);
  assert.match(runtime, /PUBLIC_SECRET_ENV_FORBIDDEN/);
  assert.doesNotMatch(health, /SERVICE_ROLE|PRIVATE_KEY|PASSWORD/i);
});

test('legacy Netlify configuration stays outside the commercial web shell', () => {
  assert.equal(fs.existsSync(path.join(root, 'netlify.toml')), true);
  assert.equal(fs.existsSync(path.join(appRoot, 'netlify.toml')), false);
});
