'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const schema=require('../scripts/verify-production-airtable-schema');

test('verifica el contrato productivo sin leer ni imprimir identificadores',async()=>{const calls=[];const fetchImpl=async(url,options)=>{calls.push({url:String(url),authorization:options.headers.Authorization});return{ok:true,status:200,json:async()=>({records:[]})}};const result=await schema.verifyProductionSchema({token:'pat-test',baseId:schema.PRODUCTION_BASE_ID,fetchImpl});assert.equal(result.tables.length,2);assert.equal(result.totalFields,46);assert.equal(calls.length,2);assert.ok(calls.every(call=>call.authorization==='Bearer pat-test'));assert.match(calls[0].url,/pageSize=1/);assert.match(calls[1].url,/Tracking\+Token\+Hash/);assert.doesNotMatch(JSON.stringify(result),/pat-test/)});

test('falla cerrado si Airtable no reconoce un campo requerido',async()=>{const fetchImpl=async()=>({ok:false,status:422,json:async()=>({error:{message:'Unknown field name'}})});await assert.rejects(()=>schema.verifyProductionSchema({token:'pat-test',baseId:schema.PRODUCTION_BASE_ID,fetchImpl}),/Unknown field name/)});

test('rechaza cualquier base distinta de producción',async()=>{await assert.rejects(()=>schema.verifyProductionSchema({token:'pat-test',baseId:'appZhq8nVZ7lZ2k6K',fetchImpl:async()=>{throw new Error('no debe consultar')}}),/solo puede apuntar/)});
