'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {CANONICAL_PRODUCTION_URL,normalizeSiteUrl,resolveInternalSiteUrl}=require('../netlify/functions/_shared/_internal_site_url');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('normaliza Netlify a HTTPS y rechaza protocolos inseguros ajenos',()=>{
  assert.equal(normalizeSiteUrl('http://villalosapamates.netlify.app/'),'https://villalosapamates.netlify.app');
  assert.equal(normalizeSiteUrl('https://villalosapamates.netlify.app/'),'https://villalosapamates.netlify.app');
  assert.equal(normalizeSiteUrl('http://example.com'),'');
});

test('el dispatcher interno nunca queda sin destino aunque Netlify omita URL',()=>{
  assert.equal(resolveInternalSiteUrl({}),CANONICAL_PRODUCTION_URL);
  assert.equal(resolveInternalSiteUrl({URL:''}),CANONICAL_PRODUCTION_URL);
  assert.equal(resolveInternalSiteUrl({DEPLOY_PRIME_URL:'https://deploy.example.netlify.app'}),'https://deploy.example.netlify.app');
});

test('acceso y autopiloto comparten el resolver endurecido',()=>{
  for(const file of [
    'netlify/functions/access-reconciliation-scheduled.js',
    'netlify/functions/condo-autopilot-scheduled.js'
  ]){
    const source=read(file);
    assert.match(source,/resolveInternalSiteUrl\(process\.env\)/,file);
    assert.doesNotMatch(source,/String\(process\.env\.URL\|\|''\)/,file);
  }
});
