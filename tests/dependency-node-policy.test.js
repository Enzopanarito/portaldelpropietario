'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

const packageJson=require('../package.json');
const workflows=fs.readdirSync('.github/workflows').filter(name=>name.endsWith('.yml')).map(name=>fs.readFileSync(path.join('.github/workflows',name),'utf8')).join('\n');

test('runtime, build Netlify y Actions usan Node 22',()=>{assert.equal(packageJson.engines.node,'>=22 <25');assert.equal(fs.readFileSync('.nvmrc','utf8').trim(),'22');assert.match(fs.readFileSync('netlify.toml','utf8'),/NODE_VERSION\s*=\s*"22"/);assert(!/node-version:\s*['"]?20/.test(workflows))});
test('Playwright está fijado en la primera versión corregida y nunca se instala temporalmente',()=>{assert.equal(packageJson.devDependencies.playwright,'1.55.1');assert(!/playwright@1\.53\.0|npm install --no-save[^\n]*playwright/.test(workflows))});
test('CI audita por separado runtime y tooling',()=>{const validate=fs.readFileSync('.github/workflows/validate.yml','utf8');assert(validate.includes('npm audit --omit=dev --audit-level=high'));assert(validate.includes('npm audit --audit-level=high'))});
