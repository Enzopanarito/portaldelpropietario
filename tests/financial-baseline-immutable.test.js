'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const{MONEY_FIELDS,compareFinancialBaseline}=require('../scripts/verify-financial-baseline');

function document(){
  return{snapshot:{casas:Array.from({length:15},(_,index)=>Object.assign({Casa:index+1,Propietario:`Casa ${index+1}`,balanceEngineVersion:'vla-balance-contract-v7'},Object.fromEntries(MONEY_FIELDS.map(field=>[field,index===7&&field==='saldoBsRef'?-0.03:0]))))}};
}

test('certifica diferencia exacta 0.00 en las 15 casas y los diez campos financieros',()=>{
  const result=compareFinancialBaseline(document(),document());
  assert.equal(result.ok,true);
  assert.equal(result.maximumAbsoluteDelta,0);
  assert.deepEqual(result.differences,[]);
  assert.equal(result.comparedFields.length,10);
});

test('detecta una alteración de un centavo y no la redondea como aceptable',()=>{
  const before=document(),after=document();
  after.snapshot.casas[10].saldoNetoReferencial=0.01;
  const result=compareFinancialBaseline(before,after);
  assert.equal(result.ok,false);
  assert.deepEqual(result.differences,[{Casa:11,field:'saldoNetoReferencial',before:0,after:0.01,delta:0.01}]);
});

test('rechaza contratos incompletos o versiones financieras antiguas',()=>{
  const after=document();
  delete after.snapshot.casas[0].saldoUsd;
  assert.throws(()=>compareFinancialBaseline(document(),after),/no es un importe financiero válido/);
  after.snapshot.casas[0].saldoUsd=0;
  after.snapshot.casas[0].balanceEngineVersion='legacy';
  assert.throws(()=>compareFinancialBaseline(document(),after),/no usa vla-balance-contract-v7/);
});
