'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'diagnose-owner-production.yml');

test('el diagnóstico de producción respeta el CSP estricto del portal', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.equal(workflow.includes('page.waitForFunction'), false);
  assert.equal(/\beval\s*\(/.test(workflow), false);
  assert.match(workflow, /casaOneOption\.waitFor\(\{ state: 'attached'/);
});
