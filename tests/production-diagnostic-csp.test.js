'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'diagnose-owner-production.yml');
const ownerWorkflowPath = path.join(__dirname, '..', '.github', 'workflows', 'verify-owner-browser.yml');
const ownerProductionPath = path.join(__dirname, 'owner-production-browser.cjs');
const mobilePath = path.join(__dirname, 'owner-mobile-browser.cjs');
const darkPath = path.join(__dirname, 'owner-dark-runtime-browser.cjs');
const paymentPath = path.join(__dirname, 'owner-payment-report-browser.cjs');

test('la certificación de producción respeta el CSP estricto del portal', () => {
  const sources = [workflowPath, ownerWorkflowPath, ownerProductionPath, mobilePath, darkPath, paymentPath]
    .map(file => fs.readFileSync(file, 'utf8'));
  for (const source of sources) {
    assert.equal(source.includes('page.waitForFunction'), false);
    assert.equal(/\beval\s*\(/.test(source), false);
  }
  assert.match(sources[0], /verify-release-contract\.js/);
  assert.match(sources[1], /verify-release-contract\.js/);
  assert.match(sources[2], /waitForHouseOptions\(page,15,30000\)/);
  assert.match(sources[2], /waitForHealthyFinancialState\(page,10000\)/);
  assert.equal(sources[3].includes('blockedTailwind<1'), false);
  assert.match(sources[4], /waitForDark\(page,10000\)/);
  assert.match(sources[5], /progressive-v12/);
});
