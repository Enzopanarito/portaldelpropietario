'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const {compareContracts,REQUIRED_KEYS}=require('../scripts/verify-release-contract');
const release=require('../release.json');

test('el gate compara el contrato completo del mismo commit',()=>{
  const equal=compareContracts(release,JSON.parse(JSON.stringify(release)));
  assert.equal(equal.ok,true);
  assert.deepEqual(equal.comparedKeys,Object.keys(release).sort());
  for(const key of REQUIRED_KEYS)assert(equal.comparedKeys.includes(key));
  for(const marker of ['financialFailClosed','paymentDatePolicy','healthControlCenter','adminE2E'])assert(equal.comparedKeys.includes(marker));
});

test('el gate falla ante cualquier marcador divergente o ausente',()=>{
  const divergent={...release,paymentReport:`${release.paymentReport}-divergente`};
  assert.equal(compareContracts(release,divergent).ok,false);
  const incomplete={...release};delete incomplete.balanceEngine;
  assert.equal(compareContracts(release,incomplete).ok,false);
  assert.throws(()=>compareContracts({release:'incompleto'},release),/marcadores obligatorios/);
});

test('el workflow no duplica manualmente los marcadores de release.json',()=>{
  const yaml=fs.readFileSync('.github/workflows/netlify-production.yml','utf8');
  assert(yaml.includes('scripts/verify-release-contract.js release.json "$production_release"'));
  assert(yaml.includes('commit_ref')&&yaml.includes('GITHUB_SHA'));
  for(const [key,value] of Object.entries(release)){
    if(typeof value==='string'&&value.length>=3)assert(!yaml.includes(value),`El workflow duplicó ${key}=${value}`);
  }
  assert(!/j\.(?:release|expectedHouses|balanceEngine|publicDataEngine|breakdownPresentation|paymentReport)\s*[!=]==?/.test(yaml));
});
