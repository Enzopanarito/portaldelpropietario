'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

function load(fields,{proof=Buffer.from('proof'),authorized=true}={}){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','_admin_payment_proof.js'))){
   if(request==='./_auth')return{requireAdmin:()=>authorized?{ok:true}:{ok:false,response:{statusCode:401,body:'{}'}}};
   if(request==='./_access_control')return{airtableGetRecord:async()=>({fields}),TABLES:{reportes:'Reportes'}};
   if(request==='./_payment_proof_store')return{createProofStore:()=>({getByKey:async()=>proof?{content:proof}:null,get:async()=>proof?{content:proof}:null})};
   if(request==='./_blobs_compat')return{connectLambdaEvent:()=>({connected:true,source:'test'})};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/_admin_payment_proof')];const loaded=require('../netlify/functions/_admin_payment_proof');Module._load=original;return loaded;
}
const event={httpMethod:'GET',headers:{},queryStringParameters:{reportId:'recABCDEFGHIJKLMN'}};

test('sirve el comprobante descifrado solo al admin',async()=>{const handler=load({'Hash SHA-256':'a'.repeat(64),'Comprobante MIME':'image/png','Comprobante Blob Key':'production/key','Comprobante Nombre Original':'pago.png'}).handler,response=await handler(event);assert.equal(response.statusCode,200);assert.equal(response.isBase64Encoded,true);assert.equal(response.headers['Cache-Control'],'private, no-store, max-age=0');assert.equal(Buffer.from(response.body,'base64').toString(),'proof')});
test('un reporte de efectivo explica que no requiere captura',async()=>{const handler=load({'Archivo Obligatorio':false}).handler,response=await handler(event);assert.equal(response.statusCode,404);assert.match(JSON.parse(response.body).message,/efectivo/i)});
test('rechaza sesiones no autorizadas',async()=>{const handler=load({}, {authorized:false}).handler,response=await handler(event);assert.equal(response.statusCode,401)});
