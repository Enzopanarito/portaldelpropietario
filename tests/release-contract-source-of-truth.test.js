'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { compareReleaseContracts } = require('../scripts/verify-release-contract');

const release = JSON.parse(fs.readFileSync('release.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/netlify-production.yml', 'utf8');

test('release.json es la única fuente del contrato desplegado', () => {
  assert.match(workflow, /verify-release-contract\.js github-output release\.json/);
  assert.match(workflow, /verify-release-contract\.js verify release\.json/);
  for (const field of ['release', 'expectedHouses', 'balanceEngine', 'publicDataEngine', 'breakdownPresentation', 'paymentReport']) {
    assert.ok(Object.hasOwn(release, field), `Falta ${field} en release.json.`);
  }
});

test('el workflow no duplica marcadores versionados del release', () => {
  for (const field of ['release', 'canonicalBalanceRelease', 'balanceSource', 'breakdownPresentation', 'paymentReport']) {
    const value = String(release[field]);
    assert.equal(workflow.includes(value), false, `${field}=${value} quedó hardcodeado en el YAML.`);
  }
});

test('la comparación cubre todo el contrato y detecta deriva', () => {
  const exact = compareReleaseContracts(release, structuredClone(release));
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.fields, Object.keys(release).sort());

  const drift = structuredClone(release);
  drift.paymentReport = 'progressive-future';
  assert.equal(compareReleaseContracts(release, drift).ok, false);

  const incomplete = structuredClone(release);
  delete incomplete.balanceEngine;
  assert.deepEqual(compareReleaseContracts(release, incomplete).differences[0], {
    field: 'balanceEngine', reason: 'missing', expected: release.balanceEngine
  });
});
