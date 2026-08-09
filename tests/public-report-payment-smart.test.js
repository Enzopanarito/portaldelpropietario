'use strict';
const assert=require('assert');
const Module=require('module');
const path=require('path');

const created=[];const mails=[];const encrypted=new Map();let reservationCount=0;
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-report-payment.js'))){
    if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
    if(request==='./_shared/_access_control')return{
      airtableCreateRecord:async(_table,fields)=>{created.push(fields);return{id:'recREPORT00000001'}},
      airtableGetRecord:async()=>({fields:{Casa:4,Propietario:'Casa 4'}}),
      syncOwnerAccess:async()=>({estado:'Habilitado',temporary:false}),
      TABLES:{reportes:'Reportes de Pago',propietarios:'Propietarios',pagos:'Pagos'},
      money:value=>Math.round((Number(value||0)+Number.EPSILON)*100)/100
    };
    if(request==='./_shared/_mailer')return{sendMail:async message=>{mails.push(message);return{sent:true,status:'Enviado'}}};
    if(request==='./_shared/_security_utils')return{
      sanitizeReference:value=>String(value||'').replace(/[<>]/g,'').trim(),
      escapeHtml:value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
      cleanPlainText:(value,max)=>String(value||'').slice(0,max),
      safeDisplayText:(value,max)=>String(value||'').slice(0,max),
      deepEscapeStrings:value=>value
    };
    if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true,retryAfter:0})};
    if(request==='./_shared/_bcv_store')return{loadLastGood:async()=>({rate:180,source:'bcv-test'})};
    if(request==='./_shared/_payment_visual_hash')return{computePerceptualHash:async()=>({hash:'0123456789abcdef',algorithm:'dhash-64-v1'})};
    if(request==='./_shared/_blobs_compat')return{connectLambdaEvent:()=>({connected:true,source:'test'})};
    if(request==='./_shared/_payment_proof_store')return{createProofStore:()=>({
      reserveIdentity:async()=>({acquired:true,created:true,key:`reservation-${++reservationCount}`,requestId:`request-${reservationCount}`}),
      completeIdentity:async()=>({completed:true}),
      put:async({content,attachmentSha})=>{const key=`test/${attachmentSha}`;encrypted.set(key,Buffer.from(content));return{key,created:true}},
      getByKey:async({key,attachmentSha,contentType})=>({key,content:Buffer.from(encrypted.get(key)),sha256:attachmentSha,contentType})
    })};
  }
  return originalLoad.apply(this,arguments);
};

global.fetch=async()=>({ok:true,status:200,json:async()=>({records:[]})});
process.env.AIRTABLE_API_TOKEN='test-token';
process.env.AIRTABLE_BASE_ID='appTEST';
process.env.SMTP_USER='villalosapamates@gmail.com';
process.env.PAYMENT_PROOF_ENCRYPTION_KEY=Buffer.alloc(32,5).toString('hex');

const handler=require('../netlify/functions/public-report-payment').handler;
Module._load=originalLoad;

function event(body){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.10'},body:JSON.stringify(body)}}
function parse(response){return JSON.parse(response.body)}
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('proof')]);
const proofSha=require('crypto').createHash('sha256').update(png).digest('hex');
const dateAttestation=require('../netlify/functions/_shared/_payment_date_attestation').signDateAttestation({ownerId:'recABCDEFGHIJKLMN',attachmentSha:proofSha,method:'MOBILE_PAYMENT_VE',transactionDate:'2026-07-31'});

(async()=>{
  let response=await handler(event({ownerId:'recABCDEFGHIJKLMN',submissionId:'submission-smart-001',mode:'USD',amount:'15.300,00',enteredCurrency:'BS',reference:'ABC-123',rate:100,bank:'Pago móvil',method:'MOBILE_PAYMENT_VE',transactionDate:'2026-07-31',transactionDateSource:'PROOF_EXTRACTED',dateAttestation,analysisSummary:{provider:'gemini-test',route:'direct',confidence:.98,transactionTime:'10:30:00',transactionStatus:'COMPLETED',recipient:'Enzo Panarito',warnings:['Lectura clara'],possibleVisualModification:false,prefillComplete:true,missingLabels:[]},observations:'Prueba',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));
  let body=parse(response);
  assert.equal(body.amountUsdRef,85);
  assert.equal(body.amountEntered,15300);
  assert.equal(body.rateApplied,180,'El servidor debe usar la tasa oficial persistida.');
  assert.equal(created[0]['Forma de Pago Reportada'],'USD');
  assert.equal(created[0]['Monto Reportado'],85);
  assert.equal(created[0]['Archivo Obligatorio'],true);
  assert(created[0]['Observaciones Reportadas'].includes('Fecha usada por el portal: 2026-07-31'));
  assert(created[0]['Observaciones Reportadas'].includes('Fuente de fecha: PROOF_EXTRACTED'));
  assert(created[0]['Observaciones Reportadas'].includes('Proveedor/modelo de prelectura: gemini-test'));
  assert(created[0]['Observaciones Reportadas'].includes('Receptor visible detectado: Enzo Panarito'));
  assert.equal(body.transactionDateConfidence,'HIGH');assert.equal(body.transactionDateNeedsReview,false);
  assert(!Object.hasOwn(created[0],'Monto Reportado Bs'),'Una cuenta USD no debe convertirse en cuenta Bs.');
  assert.equal(mails[0].attachments.length,1);
  assert.equal(mails[0].attachments[0].filename,'casa4.png');
  assert(mails[0].attachments[0].content.equals(png));
  assert(mails[0].html.includes('Pago móvil'));
  assert(mails[0].html.includes('gemini-test'));assert(mails[0].html.includes('REQUIERE CONTRASTE')===false);

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'Bs BCV',amount:'221,40',enteredCurrency:'USD',reference:'BS-123',rate:180,bank:'Zelle',method:'ZELLE',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));
  body=parse(response);
  assert.equal(body.amountUsdRef,221.4);
  assert.equal(body.amountBs,39852);
  assert.equal(created[1]['Forma de Pago Reportada'],'Bs BCV');
  assert.equal(created[1]['Monto Reportado Bs'],39852);
  assert.equal(created[1]['Tasa BCV Reporte'],180);
  assert.equal(body.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
  assert.match(body.transactionDate,/^\d{4}-\d{2}-\d{2}$/);
  assert(created[1]['Observaciones Reportadas'].includes('Fuente de fecha: REPORT_TIMESTAMP_FALLBACK'));

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:'20,00',enteredCurrency:'USD',reference:'BIN-123',bank:'Binance Pay',method:'BINANCE_PAY',attachment:{name:'binance.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));body=parse(response);
  assert.equal(body.method,'BINANCE_PAY');assert.equal(body.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',paymentChannel:'CASH',mode:'USD',amount:'50,00',enteredCurrency:'USD',cashReceiver:'Administración'}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));body=parse(response);
  assert.equal(body.paymentChannel,'CASH');assert.equal(body.attachmentIncluded,false);assert.equal(body.automation.status,'CASH_ADMIN_CONFIRMATION_REQUIRED');
  assert.equal(body.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
  assert.equal(created[3]['Archivo Obligatorio'],false);assert.equal(created[3]['Estado de Procesamiento'],'Pendiente de administrador');assert.match(created[3].Referencia,/EFECTIVO/);
  assert.equal(mails[3].attachments.length,0);

  const before=created.length;
  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'BAD-PROOF',bank:'Banco',method:'TRANSFER_VE',transactionDate:'2026-07-31',attachment:{name:'falso.png',type:'image/png',base64:Buffer.from('not-png').toString('base64')}}));
  assert.equal(response.statusCode,400);
  assert.equal(created.length,before,'Un comprobante inválido no debe crear el reporte.');

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,reference:'NO-CURRENCY',bank:'Banco',method:'TRANSFER_VE',transactionDate:'2026-07-31',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,400);
  assert.match(parse(response).message,/confirmar/i);

  for(const incomplete of [
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-PROOF',bank:'Banco',method:'TRANSFER_VE',transactionDate:'2026-07-31'},
    {ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-BANK',method:'OTHER',transactionDate:'2026-07-31',attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}
  ]){
    const count=created.length;response=await handler(event(incomplete));assert.equal(response.statusCode,400);assert.equal(created.length,count,'Los datos incompletos no deben crear reportes.');
  }

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-DATE',bank:'Pago móvil',method:'MOBILE_PAYMENT_VE',attachment:{name:'sin-fecha.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));body=parse(response);
  assert.equal(body.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');assert.equal(body.transactionDateConfidence,'LOW');assert.equal(body.transactionDateNeedsReview,true);
  assert(created.at(-1)['Observaciones Reportadas'].includes('Fecha requiere contraste: SÍ'));

  console.log('PUBLIC_REPORT_PAYMENT_SMART_OK');
})().catch(error=>{console.error(error);process.exit(1)});
