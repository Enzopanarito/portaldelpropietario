'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

process.env.PAYMENT_PROOF_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('hex');
process.env.AIRTABLE_API_TOKEN='test-token';
process.env.AIRTABLE_BASE_ID='appTEST0000000001';

const tracking=require('../netlify/functions/_shared/_payment_report_tracking');
const ownerId='recABCDEFGHIJKLMN',otherOwner='recZZZZZZZZZZZZZZ',reportId='recREPORT00000001',submissionId='tracking-test-0001',credential=tracking.createTrackingCredential(ownerId,submissionId);

test('la credencial es determinística, opaca y Airtable solo necesita su hash',()=>{
 const again=tracking.createTrackingCredential(ownerId,submissionId);
 assert.equal(again.token,credential.token);assert.equal(again.hash,credential.hash);
 assert.match(credential.token,tracking.TOKEN_PATTERN);assert.match(credential.hash,/^[a-f0-9]{64}$/);
 assert.equal(tracking.verifyTrackingToken(credential.token,credential.hash),true);
 assert.equal(tracking.verifyTrackingToken('x'.repeat(43),credential.hash),false);
 assert.equal(tracking.trackingCode(reportId,credential.token),`${reportId}.${credential.token}`);
});

test('el estado público conserva las cinco etapas sin exponer campos internos',()=>{
 const base={'Propietario que Reporta':[ownerId],'Fecha y Hora del Reporte':'2026-08-14T20:00:00.000Z','Forma de Pago Reportada':'USD','Moneda Ingresada':'USD','Monto Ingresado':50,Referencia:'ABC-12345'};
 assert.equal(tracking.statusFromFields({...base,Estado:'Pendiente','Estado de Procesamiento':'Recibido'}),'RECEIVED');
 assert.equal(tracking.statusFromFields({...base,Estado:'Pendiente','Estado de Procesamiento':'Analizando IA principal'}),'IN_REVIEW');
 assert.equal(tracking.statusFromFields({...base,Estado:'Pendiente','Estado de Procesamiento':'Información solicitada'}),'INFORMATION_REQUESTED');
 assert.equal(tracking.statusFromFields({...base,Estado:'Pendiente','Estado de Procesamiento':'Duplicado detectado'}),'IN_REVIEW','Una señal automática de duplicado no puede presentarse como rechazo.');
 assert.equal(tracking.statusFromFields({...base,Estado:'Confirmado'}),'APPROVED');
 assert.equal(tracking.statusFromFields({...base,Estado:'Rechazado'}),'REJECTED');
 const dto=tracking.sanitizeReport({id:reportId,fields:{...base,Estado:'Pendiente','Estado de Procesamiento':'Información solicitada','Solicitud de Información':'Adjunta una referencia legible','Hash SHA-256':'a'.repeat(64),'Tracking Token Hash':credential.hash}});
 assert.equal(dto.status,'INFORMATION_REQUESTED');assert.equal(dto.canRespond,true);assert.equal(dto.referenceEnding,'••••2345');assert.equal(dto.reviewDeadline,'2026-08-17T20:00:00.000Z');
 assert.equal(Object.hasOwn(dto,'Tracking Token Hash'),false);assert.equal(Object.hasOwn(dto,'Hash SHA-256'),false);
});

function loadStatus(record){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-payment-report-status.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_access_control')return{airtableGetRecord:async()=>record,TABLES:{reportes:'Reportes'}};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/public-payment-report-status')];const loaded=require('../netlify/functions/public-payment-report-status');Module._load=original;return loaded;
}
function event(body){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.25'},body:JSON.stringify(body)}}
function parse(response){return JSON.parse(response.body)}

test('Mis reportes exige propietario, ID exacto y token; una credencial errónea no filtra datos',async()=>{
 const record={id:reportId,fields:{'Propietario que Reporta':[ownerId],'Tracking Token Hash':credential.hash,Estado:'Pendiente','Estado de Procesamiento':'Recibido','Fecha y Hora del Reporte':'2026-08-14T20:00:00.000Z'}};
 const handler=loadStatus(record).handler;
 let response=await handler(event({ownerId,reports:[{reportId,token:credential.token}]}));assert.equal(response.statusCode,200);assert.equal(parse(response).reports.length,1);
 response=await handler(event({ownerId,reports:[{reportId,token:'x'.repeat(43)}]}));assert.equal(response.statusCode,200);assert.deepEqual(parse(response).reports,[]);
 response=await handler(event({ownerId:otherOwner,reports:[{reportId,token:credential.token}]}));assert.equal(response.statusCode,200);assert.deepEqual(parse(response).reports,[]);
});

function loadSupplement(state){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-payment-report-supplement.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_access_control')return{TABLES:{reportes:'Reportes'},airtableGetRecord:async()=>state.record,airtablePatchRecord:async(_table,_id,patch)=>{state.patch=patch;state.patchCount+=1;state.record={...state.record,fields:{...state.record.fields,...patch}};return state.record}};
   if(request==='./_shared/_security_utils')return{cleanPlainText:(value,max)=>String(value||'').slice(0,max),safeDisplayText:(value,max)=>String(value||'').slice(0,max)};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_shared/_payment_admin_decision')return{appendAudit:()=>'{"safe":true}'};
   if(request==='./_shared/_payment_report_attachment')return{decodeAttachment:()=>null};
   if(request==='./_shared/_payment_proof_store')return{createProofStore:()=>{throw new Error('No debe abrir Blobs sin adjunto.')}};
   if(request==='./_shared/_blobs_compat')return{connectLambdaEvent:()=>{throw new Error('No debe conectar Blobs sin adjunto.')}};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/public-payment-report-supplement')];const loaded=require('../netlify/functions/public-payment-report-supplement');Module._load=original;return loaded;
}

test('el propietario completa el mismo reporte y no crea pagos, saldos ni accesos',async()=>{
 const state={patch:null,patchCount:0,record:{id:reportId,fields:{'Propietario que Reporta':[ownerId],'Tracking Token Hash':credential.hash,Estado:'Pendiente','Estado de Procesamiento':'Información solicitada','Solicitud de Información':'Aclara la referencia'}}},handler=loadSupplement(state).handler;
 let response=await handler(event({ownerId,reportId,token:'x'.repeat(43),message:'Referencia correcta ABC-123'}));assert.equal(response.statusCode,404);assert.equal(state.patchCount,0);
 response=await handler(event({ownerId,reportId,token:credential.token,message:'Referencia correcta ABC-123'}));assert.equal(response.statusCode,200,JSON.stringify(parse(response)));assert.equal(state.patchCount,1);
 assert.equal(state.patch['Estado de Procesamiento'],'Pendiente de administrador');assert.equal(state.patch['Decisión Administrativa'],'Pendiente');assert.match(state.patch['Respuesta del Propietario'],/Referencia correcta ABC-123/);
 assert.equal(Object.keys(state.patch).some(key=>/saldo|acceso|pago definitivo/i.test(key)),false);
 assert.match(parse(response).message,/sin crear uno nuevo/i);
});
