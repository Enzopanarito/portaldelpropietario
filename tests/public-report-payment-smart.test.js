'use strict';
const assert=require('assert');
const Module=require('module');
const path=require('path');

const created=[];const mails=[];
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-report-payment.js'))){
    if(request==='./_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
    if(request==='./_access_control')return{
      airtableCreateRecord:async(_table,fields)=>{created.push(fields);return{id:'recREPORT00000001'}},
      airtableGetRecord:async()=>({fields:{Casa:4,Propietario:'Casa 4'}}),
      syncOwnerAccess:async()=>({estado:'Habilitado',temporary:false}),
      TABLES:{reportes:'Reportes de Pago',propietarios:'Propietarios'},
      money:value=>Math.round((Number(value||0)+Number.EPSILON)*100)/100
    };
    if(request==='./_mailer')return{sendMail:async message=>{mails.push(message);return{sent:true,status:'Enviado'}}};
    if(request==='./_security_utils')return{
      sanitizeReference:value=>String(value||'').replace(/[<>]/g,'').trim(),
      escapeHtml:value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
      cleanPlainText:(value,max)=>String(value||'').slice(0,max),
      safeDisplayText:(value,max)=>String(value||'').slice(0,max),
      deepEscapeStrings:value=>value
    };
    if(request==='./_persistent_rate_limit')return{consume:async()=>({allowed:true,retryAfter:0})};
    if(request==='./_bcv_store')return{loadLastGood:async()=>({rate:180,source:'bcv-test'})};
  }
  return originalLoad.apply(this,arguments);
};

global.fetch=async()=>({ok:true,status:200,json:async()=>({records:[]})});
process.env.AIRTABLE_API_TOKEN='test-token';
process.env.AIRTABLE_BASE_ID='appTEST';
process.env.SMTP_USER='villalosapamates@gmail.com';

const handler=require('../netlify/functions/public-report-payment').handler;
Module._load=originalLoad;

function event(body){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.10'},body:JSON.stringify(body)}}
function parse(response){return JSON.parse(response.body)}
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('proof')]);

(async()=>{
  let response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:'15.300,00',enteredCurrency:'BS',reference:'ABC-123',rate:100,bank:'Pago móvil',transactionDate:'2026-07-31',transactionStatus:'COMPLETED',observations:'Prueba',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));
  let body=parse(response);
  assert.equal(body.amountUsdRef,85);
  assert.equal(body.amountEntered,15300);
  assert.equal(body.rateApplied,180,'El servidor debe usar la tasa oficial persistida.');
  assert.equal(created[0]['Forma de Pago Reportada'],'USD');
  assert.equal(created[0]['Monto Reportado'],85);
  assert.equal(created[0]['Archivo Obligatorio'],true);
  assert(created[0]['Observaciones Reportadas'].includes('Fecha de operación indicada: 2026-07-31'));
  assert(!Object.hasOwn(created[0],'Monto Reportado Bs'),'Una cuenta USD no debe convertirse en cuenta Bs.');
  assert.equal(mails[0].attachments.length,1);
  assert.equal(mails[0].attachments[0].filename,'casa4.png');
  assert(mails[0].attachments[0].content.equals(png));
  assert(mails[0].html.includes('Pago móvil'));

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'Bs BCV',amount:'221,40',enteredCurrency:'USD',reference:'BS-123',rate:180,bank:'Zelle',transactionDate:'2026-07-30',transactionStatus:'SENT',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));
  body=parse(response);
  assert.equal(body.amountUsdRef,221.4);
  assert.equal(body.amountBs,39852);
  assert.equal(created[1]['Forma de Pago Reportada'],'Bs BCV');
  assert.equal(created[1]['Monto Reportado Bs'],39852);
  assert.equal(created[1]['Tasa BCV Reporte'],180);

  const before=created.length;
  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'BAD-PROOF',bank:'Banco',transactionDate:'2026-07-31',transactionStatus:'PROCESSED',attachment:{name:'falso.png',type:'image/png',base64:Buffer.from('not-png').toString('base64')}}));
  assert.equal(response.statusCode,400);
  assert.equal(created.length,before,'Un comprobante inválido no debe crear el reporte.');

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,reference:'NO-CURRENCY',bank:'Banco',transactionDate:'2026-07-31',transactionStatus:'COMPLETED',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,400);
  assert.match(parse(response).message,/confirmar/i);

  for(const incomplete of [
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-PROOF',bank:'Banco',transactionDate:'2026-07-31',transactionStatus:'COMPLETED'},
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-BANK',transactionDate:'2026-07-31',transactionStatus:'COMPLETED',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}},
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-DATE',bank:'Banco',transactionStatus:'COMPLETED',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}},
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'PENDING',bank:'Banco',transactionDate:'2026-07-31',transactionStatus:'PENDING',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}
  ]){
    const count=created.length;response=await handler(event(incomplete));assert.equal(response.statusCode,400);assert.equal(created.length,count,'Los datos incompletos no deben crear reportes.');
  }

  console.log('PUBLIC_REPORT_PAYMENT_SMART_OK');
})().catch(error=>{console.error(error);process.exit(1)});
