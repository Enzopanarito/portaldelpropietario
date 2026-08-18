'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

const packageJson=require('../package.json');
const workflowNames=fs.readdirSync('.github/workflows').filter(name=>name.endsWith('.yml'));
const workflowSources=workflowNames.map(name=>({name,source:fs.readFileSync(path.join('.github/workflows',name),'utf8')}));
const workflows=workflowSources.map(item=>item.source).join('\n');
const canonicalNode24Workflows=[
  'validate.yml',
  'netlify-production.yml',
  'netlify-cli-preview.yml',
  'capture-final-financial-baseline.yml',
  'verify-owner-browser.yml',
  'verify-owner-mobile.yml',
  'verify-admin-preview.yml',
  'verify-admin-premium.yml'
];

test('runtime canónico, build Netlify y gates principales usan Node 24',()=>{
  assert.equal(packageJson.engines.node,'>=22 <25');
  assert.equal(fs.readFileSync('.nvmrc','utf8').trim(),'24');
  assert.match(fs.readFileSync('netlify.toml','utf8'),/NODE_VERSION\s*=\s*"24"/);
  const offenders=canonicalNode24Workflows.filter(name=>{
    const source=fs.readFileSync(path.join('.github/workflows',name),'utf8');
    return !/node-version:\s*['"]?24['"]?/.test(source)||/node-version:\s*['"]?(?:20|22)['"]?/.test(source);
  });
  assert.deepEqual(offenders,[],`Workflows canónicos fuera de Node 24: ${offenders.join(', ')}`);
  assert.match(fs.readFileSync('.github/workflows/netlify-production.yml','utf8'),/AWS_LAMBDA_JS_RUNTIME:\s*nodejs24\.x/);
});
test('Playwright está fijado en la primera versión corregida y nunca se instala temporalmente',()=>{assert.equal(packageJson.devDependencies.playwright,'1.55.1');assert(!/playwright@1\.53\.0|npm install --no-save[^\n]*playwright/.test(workflows))});
test('CI audita por separado runtime y tooling',()=>{const validate=fs.readFileSync('.github/workflows/validate.yml','utf8');assert(validate.includes('npm audit --omit=dev --audit-level=high'));assert(validate.includes('npm audit --audit-level=high'))});
