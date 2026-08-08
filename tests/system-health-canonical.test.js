'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {canonicalFinancialState}=require('../netlify/functions/system-health');
function payload(){return{propietarios:Array.from({length:15},(_,index)=>({Casa:index+1,saldoUsd:index===7?70:0,saldoBsRef:index===7?-.03:0,totalPagadero:index===7?70:0,saldoNetoReferencial:index===7?69.97:0,balanceEngineVersion:'vla-balance-contract-v7'}))}}
test('Health valida 15/15 y la separación USD/Bs',()=>{assert.deepEqual(canonicalFinancialState(payload()),{ok:true,count:15,invalid:[]})});
test('Health identifica la Casa 8 si alguien vuelve a publicar 69.97 como pagadero',()=>{const data=payload();data.propietarios[7].totalPagadero=69.97;assert.deepEqual(canonicalFinancialState(data),{ok:false,count:15,invalid:[8]})});
