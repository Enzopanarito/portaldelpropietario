'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const release=require('../release.json');
const {canonicalFinancialState,releaseContractState}=require('../netlify/functions/system-health');
function payload(){return{propietarios:Array.from({length:15},(_,index)=>({Casa:index+1,saldoUsd:index===7?70:0,saldoBsRef:index===7?-.03:0,totalPagadero:index===7?70:0,saldoNetoReferencial:index===7?69.97:0,balanceEngineVersion:'vla-balance-contract-v7'}))}}
test('Health valida 15/15 y la separación USD/Bs',()=>{assert.deepEqual(canonicalFinancialState(payload()),{ok:true,count:15,invalid:[]})});
test('Health identifica la Casa 8 si alguien vuelve a publicar 69.97 como pagadero',()=>{const data=payload();data.propietarios[7].totalPagadero=69.97;assert.deepEqual(canonicalFinancialState(data),{ok:false,count:15,invalid:[8]})});
test('Health enlaza el contrato completo de release con el commit desplegado',()=>{const state=releaseContractState(release,structuredClone(release),{schemaVersion:'vla-deployment-manifest-v1',release:release.release,releaseContractDigest:require('../scripts/verify-release-contract').contractDigest(release),commit:'a'.repeat(40)});assert.equal(state.ok,true);assert.equal(state.differences.length,0)});
test('Health falla si cambia cualquier campo del release o falta un commit válido',()=>{const drift={...release,expectedHouses:14};const state=releaseContractState(release,drift,{schemaVersion:'vla-deployment-manifest-v1',release:release.release,releaseContractDigest:'x',commit:'unknown'});assert.equal(state.ok,false);assert.deepEqual(state.differences,['expectedHouses']);assert.equal(state.manifestOk,false)});
