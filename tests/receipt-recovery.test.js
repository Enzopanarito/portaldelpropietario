'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

function response(status,data){return{ok:status>=200&&status<300,status,json:async()=>data}}

async function loadService({receiptStatus='Error PDF',patchFails=false}={}){
 const originalLoad=Module._load;
 let mailCalls=0,pdfCalls=0;
 Module._load=function(request,parent,isMain){
  if(parent?.filename?.endsWith('_receipt_service.js')&&request==='./_mailer')return{sendMail:async input=>{mailCalls+=1;assert.equal(input.attachments?.[0]?.contentType,'application/pdf');return{sent:true,status:'Enviado',detail:'OK'}}};
  if(parent?.filename?.endsWith('_receipt_service.js')&&request==='./_receipt_pdf')return{buildReceiptPdf:async()=>{pdfCalls+=1;return Buffer.from('%PDF-1.7 test')}};
  return originalLoad.call(this,request,parent,isMain);
 };
 delete require.cache[require.resolve('../netlify/functions/_shared/_receipt_service')];
 const service=require('../netlify/functions/_shared/_receipt_service');
 Module._load=originalLoad;

 const calls=[];
 global.fetch=async(url,options={})=>{
  const method=options.method||'GET';calls.push({url:String(url),method,body:options.body});
  if(String(url).includes('Recibos%20de%20Pago')&&method==='GET')return response(200,{id:'recReceipt123456',fields:{'Nro Recibo':'REC-TEST-1',Casa:8,Fecha:'2026-08-01','Monto USD':20,'Monto Bs':0,'Forma de Pago':'USD',Referencia:'123456',Correo:'owner@example.com','Estado Email':receiptStatus,Propietario:['recOwner123456']}});
  if(String(url).includes('Propietarios')&&method==='GET')return response(200,{id:'recOwner123456',fields:{Propietario:'Persona Prueba',Casa:8,Email:'owner@example.com'}});
  if(String(url).includes('Recibos%20de%20Pago')&&method==='PATCH')return patchFails?response(503,{error:{message:'Airtable temporalmente no disponible'}}):response(200,{id:'recReceipt123456',fields:JSON.parse(options.body).fields});
  throw new Error(`Fetch inesperado: ${method} ${url}`);
 };
 return{service,calls,counts:()=>({mailCalls,pdfCalls})};
}

test('reintenta sobre el mismo recibo, adjunta el PDF y nunca crea otro registro',async()=>{
 process.env.AIRTABLE_API_TOKEN='test-token';process.env.AIRTABLE_BASE_ID='appTestBase';
 const {service,calls,counts}=await loadService();
 const result=await service.retryExistingReceipt('recReceipt123456');
 assert.equal(result.email.sent,true);
 assert.equal(result.receipt.fields['Estado Email'],'Enviado');
 assert.match(result.receipt.fields.Log,/Recuperación automática/);
 assert.equal(calls.filter(call=>call.method==='PATCH').length,1);
 assert.equal(calls.filter(call=>call.method==='POST').length,0);
 assert.deepEqual(counts(),{mailCalls:1,pdfCalls:1});
});

test('un recibo ya enviado es idempotente y no vuelve a mandar correo',async()=>{
 process.env.AIRTABLE_API_TOKEN='test-token';process.env.AIRTABLE_BASE_ID='appTestBase';
 const {service,calls,counts}=await loadService({receiptStatus:'Enviado'});
 const result=await service.retryExistingReceipt('recReceipt123456');
 assert.equal(result.idempotent,true);
 assert.equal(calls.filter(call=>call.method==='PATCH').length,0);
 assert.deepEqual(counts(),{mailCalls:0,pdfCalls:0});
});

test('si el correo salió y falla la auditoría, marca el caso para reparar sin reenviar',async()=>{
 process.env.AIRTABLE_API_TOKEN='test-token';process.env.AIRTABLE_BASE_ID='appTestBase';
 const {service,counts}=await loadService({patchFails:true});
 await assert.rejects(()=>service.retryExistingReceipt('recReceipt123456'),error=>{
  assert.equal(error.code,'RECEIPT_SENT_AIRTABLE_PATCH_FAILED');
  assert.equal(error.deliverySent,true);
  assert.equal(error.deliveryAudit.email,'owner@example.com');
  return true;
 });
 assert.deepEqual(counts(),{mailCalls:1,pdfCalls:1});
});
