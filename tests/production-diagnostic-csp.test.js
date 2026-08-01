'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'diagnose-owner-production.yml');
const ownerWorkflowPath = path.join(__dirname, '..', '.github', 'workflows', 'verify-owner-browser.yml');
const mobilePath = path.join(__dirname, 'owner-mobile-browser.cjs');
const darkPath = path.join(__dirname, 'owner-dark-contrast-browser.cjs');

test('el diagnóstico de producción respeta el CSP estricto del portal', () => {
  const sources = [workflowPath, ownerWorkflowPath, mobilePath, darkPath]
    .map(file => fs.readFileSync(file, 'utf8'));
  for (const source of sources) {
    assert.equal(source.includes('page.waitForFunction'), false);
    assert.equal(/\beval\s*\(/.test(source), false);
  }
  assert.match(sources[0], /waitForCasaOne\(page, 60000\)/);
  assert.equal(sources[2].includes("blockedTailwind<1"), false);
});
