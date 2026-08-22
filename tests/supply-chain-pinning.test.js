'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
function source(file){return fs.readFileSync(path.join(root,file),'utf8');}

const cliCritical=[
  '.github/workflows/netlify-production.yml',
  '.github/workflows/netlify-cli-preview.yml'
];
const actionCritical=[
  ...cliCritical,
  '.github/workflows/netlify-production-auto-rollback.yml'
];

test('deploys críticos no dependen de Netlify CLI latest',()=>{
  for(const file of cliCritical){
    const text=source(file);
    assert.doesNotMatch(text,/netlify-cli@latest/i,`${file} no puede instalar latest`);
    assert.match(text,/NETLIFY_CLI_VERSION:\s*'27\.1\.2'/,`${file} debe fijar la versión aprobada`);
    assert.match(text,/netlify-cli@\$\{NETLIFY_CLI_VERSION\}/,`${file} debe usar exactamente la versión fijada`);
  }
});

test('checkout y setup-node están fijados por SHA en deploy, preview y rollback',()=>{
  const checkout='d23441a48e516b6c34aea4fa41551a30e30af803';
  const setup='249970729cb0ef3589644e2896645e5dc5ba9c38';
  for(const file of actionCritical){
    const text=source(file);
    assert.match(text,new RegExp(`actions/checkout@${checkout}`),`${file} debe fijar checkout por SHA`);
    assert.match(text,new RegExp(`actions/setup-node@${setup}`),`${file} debe fijar setup-node por SHA`);
    assert.doesNotMatch(text,/actions\/(checkout|setup-node)@v\d+\b/,`${file} no debe depender de tags mutables para las Actions críticas`);
  }
});

test('producción conserva los gates financieros mientras fija tooling',()=>{
  const text=source('.github/workflows/netlify-production.yml');
  assert.match(text,/Capture immediate BEFORE financial baseline/);
  assert.match(text,/Compare AFTER against immediate BEFORE in exact cents/);
  assert.match(text,/FINANCIAL_BEFORE_AFTER_OK 15\/15 houses · 150\/150 fields · \$0\.00/);
  assert.match(text,/--no-build/);
});

test('rollback conserva verificación de release y 150 campos financieros',()=>{
  const text=source('.github/workflows/netlify-production-auto-rollback.yml');
  assert.match(text,/Verify restored release and 150 financial fields/);
  assert.match(text,/ROLLBACK_FINANCIAL_BASELINE_OK 15\/15 houses · 150\/150 fields/);
});
