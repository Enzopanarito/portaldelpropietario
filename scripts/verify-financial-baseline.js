#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');

const MONEY_FIELDS=[
  'saldoUsd','saldoBsRef','totalPagadero','saldoNetoReferencial',
  'saldoFavorUsd','saldoFavorBs','deudaVencidaUsd','deudaVencidaBs',
  'mesCorrienteUsd','mesCorrienteBs'
];

function fail(message){const error=new Error(message);error.code='VLA_FINANCIAL_BASELINE_MISMATCH';throw error}
function cents(value,context){
  const number=Number(value);
  if(!Number.isFinite(number))fail(`${context} no es un importe financiero válido.`);
  return Math.round((number+Number.EPSILON)*100);
}
function ownersOf(document){
  if(Array.isArray(document?.snapshot?.casas))return document.snapshot.casas;
  if(Array.isArray(document?.propietarios))return document.propietarios;
  if(Array.isArray(document?.casas))return document.casas;
  fail('El documento no contiene snapshot.casas, casas ni propietarios.');
}
function canonicalOwners(document,label){
  const owners=ownersOf(document);
  if(owners.length!==15)fail(`${label}: se esperaban 15 casas y llegaron ${owners.length}.`);
  const normalized=owners.map(owner=>{
    const Casa=Number(owner?.Casa);
    if(!Number.isInteger(Casa)||Casa<1||Casa>15)fail(`${label}: número de Casa inválido.`);
    if(owner.balanceEngineVersion!=='vla-balance-contract-v7')fail(`${label}: la Casa ${Casa} no usa vla-balance-contract-v7.`);
    const result={Casa,Propietario:String(owner.Propietario||'')};
    for(const field of MONEY_FIELDS)result[field]=cents(owner[field],`${label} Casa ${Casa}.${field}`);
    return result;
  }).sort((a,b)=>a.Casa-b.Casa);
  const houses=normalized.map(owner=>owner.Casa);
  if(new Set(houses).size!==15||houses.some((house,index)=>house!==index+1))fail(`${label}: las casas deben ser únicas y consecutivas del 1 al 15.`);
  return normalized;
}
function compareFinancialBaseline(beforeDocument,afterDocument){
  const before=canonicalOwners(beforeDocument,'BEFORE'),after=canonicalOwners(afterDocument,'AFTER'),differences=[];
  for(let index=0;index<before.length;index+=1){
    const expected=before[index],actual=after[index];
    if(expected.Casa!==actual.Casa)fail(`AFTER: orden inesperado en la Casa ${actual.Casa}.`);
    for(const field of MONEY_FIELDS){
      const delta=actual[field]-expected[field];
      if(delta!==0)differences.push({Casa:expected.Casa,field,before:expected[field]/100,after:actual[field]/100,delta:delta/100});
    }
  }
  const maximumAbsoluteDelta=differences.reduce((maximum,item)=>Math.max(maximum,Math.abs(item.delta)),0);
  return{ok:differences.length===0,schema:'vla-financial-baseline-diff-v1',expectedHouses:15,comparedFields:MONEY_FIELDS,maximumAbsoluteDelta,differences};
}
function readJson(file){return JSON.parse(fs.readFileSync(path.resolve(file),'utf8'))}
function main(argv=process.argv.slice(2)){
  const [beforeFile,afterFile,outputFile]=argv;
  if(!beforeFile||!afterFile)throw new Error('Uso: node scripts/verify-financial-baseline.js BEFORE.json AFTER.json [DIFF.json]');
  const result=compareFinancialBaseline(readJson(beforeFile),readJson(afterFile));
  const rendered=JSON.stringify({...result,verifiedAt:new Date().toISOString()},null,2)+'\n';
  if(outputFile)fs.writeFileSync(path.resolve(outputFile),rendered,'utf8');
  process.stdout.write(rendered);
  if(!result.ok)process.exitCode=1;
}

if(require.main===module){try{main()}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={MONEY_FIELDS,cents,ownersOf,canonicalOwners,compareFinancialBaseline};
