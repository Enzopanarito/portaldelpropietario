'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const background=require('../netlify/functions/access-reconciliation-background');

test('clasifica divergencias puras de estado como autorreparables',()=>{
  const audit={discrepancies:[
    {casa:3,discrepancias:['MKJ_EXPECTATION_MISMATCH']},
    {casa:12,discrepancias:['AIRTABLE_EXPECTATION_MISMATCH']},
    {casa:9,discrepancias:['MKJ_EXPECTATION_MISMATCH','AIRTABLE_EXPECTATION_MISMATCH']}
  ]};
  const result=background.classifyRepairability(audit);
  assert.equal(result.repairable.length,3);
  assert.equal(result.unsafe.length,0);
});

test('bloquea discrepancias de identidad o lectura para evitar escrituras ambiguas',()=>{
  const audit={discrepancies:[
    {casa:4,discrepancias:['STALE_MEMBER_ID','MKJ_EXPECTATION_MISMATCH']},
    {casa:7,discrepancias:['EMAIL_MISMATCH']},
    {casa:10,discrepancias:['MKJ_STATE_UNKNOWN']}
  ]};
  const result=background.classifyRepairability(audit);
  assert.equal(result.repairable.length,0);
  assert.equal(result.unsafe.length,3);
});

test('el job horario audita, fuerza reparación solo ante drift y verifica después',()=>{
  const source=fs.readFileSync('netlify/functions/access-reconciliation-background.js','utf8');
  assert.match(source,/runReadOnlyReconciliation\(\)/);
  assert.match(source,/autoSyncAll\(\{forceMkj:true/);
  assert.match(source,/MKJ_REPAIR_NOT_VERIFIED/);
  assert.match(source,/UNSAFE_MKJ_DISCREPANCY/);
});
