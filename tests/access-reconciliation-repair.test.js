'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {repairableRemoteDrift}=require('../netlify/functions/access-reconciliation-background');

function row(overrides={}){
 return{
  casa:3,
  mkjUserId:'mkj-3',
  mkjResolvedUserId:'mkj-3',
  estadoEsperadoVla:'Limitado',
  estadoFisicoEsperado:'Limitado',
  estadoAirtable:'Limitado',
  estadoMkj:'Habilitado',
  discrepancias:['MKJ_EXPECTATION_MISMATCH'],
  ...overrides
 };
}

test('repara solo deriva física MKJ con identidad y Airtable coherentes',()=>{
 assert.equal(repairableRemoteDrift(row()),true);
});

test('no repara automáticamente identidad, email o Airtable dudosos',()=>{
 assert.equal(repairableRemoteDrift(row({discrepancias:['MKJ_EXPECTATION_MISMATCH','EMAIL_MISMATCH']})),false);
 assert.equal(repairableRemoteDrift(row({discrepancias:['AIRTABLE_EXPECTATION_MISMATCH']})),false);
 assert.equal(repairableRemoteDrift(row({mkjResolvedUserId:'otro'})),false);
 assert.equal(repairableRemoteDrift(row({estadoAirtable:'Habilitado'})),false);
});

test('no toca filas ya coherentes',()=>{
 assert.equal(repairableRemoteDrift(row({estadoMkj:'Limitado',discrepancias:[]})),false);
});
