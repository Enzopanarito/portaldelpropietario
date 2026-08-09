'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {canonicalOwnerFields}=require('../netlify/functions/admin-data-v3');

test('admin recibe el mismo contrato canónico y no un cálculo alterno',()=>{
 const fields=canonicalOwnerFields({usd:50,bsRef:-294.76,totalRef:-244.76,expiredUsd:0,expiredBsRef:0,currentUsd:50,currentBsRef:-294.76});
 assert.deepEqual({usd:fields.saldoUsd,bs:fields.saldoBsRef,payable:fields.totalPagadero,net:fields.saldoNetoReferencial,version:fields.balanceEngineVersion},{usd:50,bs:-294.76,payable:50,net:-244.76,version:'vla-balance-contract-v7'});
});

test('admin falla cerrado si el motor no entrega todos los componentes',()=>{
 assert.throws(()=>canonicalOwnerFields({usd:50,bsRef:0,totalRef:50}),error=>error.code==='FINANCIAL_CONTRACT_INCOMPLETE');
});
