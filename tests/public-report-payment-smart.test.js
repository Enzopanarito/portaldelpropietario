'use strict';
const assert=require('assert');
const Module=require('module');
const path=require('path');

const created=[];const mails=[];const encrypted=new Map();let reservationCount=0;let historicalExactDuplicate=false,historicalFinancialDuplicate=false;
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

global.fetch=async input=>{
  const url=String(input||'');
  let records=[];
  if(url.includes('Reportes%20de%20Pago')&&url.includes('Hash+SHA-256')){
    if(historicalExactDuplicate)records=[{id:'recHISTORICAL0001',fields:{'Hash SHA-256':proofSha}}];
    else if(historicalFinancialDuplicate)records=[{id:'recFINANCIAL00001',fields:{'Hash SHA-256':'b'.repeat(64),Referencia:'EXACT-FIN-001','Referencia Detectada':'EXACT-FIN-001','Banco o Plataforma Detectada':'Zelle','Método Detectado':'ZELLE','Moneda Detectada':'USD','Monto Detectado':85,'Fecha Operación Detectada':'2026-08-12'}}];
  }
  return{ok:true,status:200,json:async()=>({records})};
};
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
const zelleDateAttestation=require('../netlify/functions/_shared/_payment_date_attestation').signDateAttestation({ownerId:'recABCDEFGHIJKLMN',attachmentSha:proofSha,method:'ZELLE',transactionDate:'2026-08-12'});
const unauthorizedRecipientAttestation=require('../netlify/functions/_shared/_payment_recipient_attestation').signRecipientAttestation({ownerId:'recABCDEFGHIJKLMN',attachmentSha:proofSha,method:'MOBILE_PAYMENT_VE',classification:'UNAUTHORIZED'});
const {todayCaracasISO}=require('../netlify/functions/_shared/_payment_date_resolver');

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
  assert.match(body.trackingCode,/^rec[A-Za-z0-9]{14}\.[A-Za-z0-9_-]{43}$/);
  assert.match(created[0]['Tracking Token Hash'],/^[a-f0-9]{64}$/);
  assert(!JSON.stringify(created[0]).includes(body.trackingCode.split('.')[1]),'Airtable no puede recibir el token privado en texto claro.');
  assert(created[0]['Observaciones Reportadas'].includes('Fecha de operación: 2026-07-31'));
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

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'Bs BCV',amount:'221,40',enteredCurrency:'USD',reference:'BS-123',rate:180,bank:'Zelle',method:'ZELLE',uncertaintyAcknowledged:true,attachment:{name:'casa4.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));
  body=parse(response);
  assert.equal(body.amountUsdRef,221.4);
  assert.equal(body.amountBs,39852);
  assert.equal(created[1]['Forma de Pago Reportada'],'Bs BCV');
  assert.equal(created[1]['Monto Reportado Bs'],39852);
  assert.equal(created[1]['Tasa BCV Reporte'],180);
  assert.equal(body.transactionDateSource,'UNDETERMINED');
  assert.equal(body.transactionDate,todayCaracasISO(new Date(body.reportTimestamp)));
  assert(created[1]['Observaciones Reportadas'].includes('Fuente de fecha: UNDETERMINED'));
  assert.equal(created[1]['Fecha Operación Detectada'],body.transactionDate);
  assert.match(created[1]['Evidencia Fecha Operación'],/provisionalmente.*fecha del reporte/i);

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:'20,00',enteredCurrency:'USD',reference:'BIN-123',bank:'Binance Pay',method:'BINANCE_PAY',uncertaintyAcknowledged:true,attachment:{name:'binance.png',type:'image/png',base64:png.toString('base64')}}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));body=parse(response);
  assert.equal(body.method,'BINANCE_PAY');assert.equal(body.transactionDateSource,'UNDETERMINED');assert.equal(body.transactionDate,todayCaracasISO(new Date(body.reportTimestamp)));

  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',paymentChannel:'CASH',mode:'USD',amount:'50,00',enteredCurrency:'USD',cashReceiver:'Administración'}));
  assert.equal(response.statusCode,200,JSON.stringify(parse(response)));body=parse(response);
  assert.equal(body.paymentChannel,'CASH');assert.equal(body.attachmentIncluded,false);assert.equal(body.automation.status,'CASH_ADMIN_CONFIRMATION_REQUIRED');
  const cashReportDate=todayCaracasISO(new Date(body.reportTimestamp));
  assert.equal(body.transactionDate,cashReportDate);assert.equal(body.transactionDateSource,'USER_CONFIRMED');assert.equal(body.transactionDateConfidence,'HIGH');assert.equal(body.transactionDateNeedsReview,false);
  assert.equal(created[3]['Fecha Operación Detectada'],cashReportDate);assert.equal(created[3]['Fecha del Reporte'],cashReportDate);assert.match(created[3]['Evidencia Fecha Operación'],/servidor.*Venezuela/i);
  assert.equal(created[3]['Archivo Obligatorio'],false);assert.equal(created[3]['Estado de Procesamiento'],'Pendiente de administrador');assert.match(created[3].Referencia,/EFECTIVO/);
  assert.equal(mails[3].attachments.length,0);assert.match(mails[3].html,/Asignada automáticamente al crear el reporte de efectivo/);

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

  const beforeUncertain=created.length;
  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',mode:'USD',amount:85,enteredCurrency:'USD',reference:'NO-DATE',bank:'Pago móvil',method:'MOBILE_PAYMENT_VE',attachment:{name:'sin-fecha.png',type:'image/png',base64:png.toString('base64')}}));body=parse(response);
  assert.equal(response.statusCode,200,JSON.stringify(body));assert.equal(created.length,beforeUncertain+1,'Una fecha ilegible debe enviarse a revisión sin interrumpir al propietario.');
  assert.equal(body.transactionDateSource,'UNDETERMINED');assert.equal(body.transactionDate,todayCaracasISO(new Date(body.reportTimestamp)));assert.equal(body.transactionDateConfidence,'LOW');assert.equal(body.transactionDateNeedsReview,true);
  assert(created.at(-1)['Observaciones Reportadas'].includes('Fecha requiere contraste: SÍ'));

  const beforeRecipientMismatch=created.length;
  const mismatchPayload={ownerId:'recABCDEFGHIJKLMN',submissionId:'submission-recipient-mismatch-001',mode:'USD',amount:85,enteredCurrency:'USD',reference:'RECIPIENT-MISMATCH',bank:'Pago móvil',method:'MOBILE_PAYMENT_VE',recipientAttestation:unauthorizedRecipientAttestation,analysisSummary:{provider:'gemini-test',route:'direct',confidence:.98,transactionStatus:'COMPLETED',recipient:'Persona distinta',prefillComplete:true},attachment:{name:'receptor-distinto.png',type:'image/png',base64:png.toString('base64')}};
  response=await handler(event(mismatchPayload));body=parse(response);
  assert.equal(response.statusCode,428,JSON.stringify(body));assert.equal(body.confirmationCode,'RECIPIENT_MISMATCH');assert.equal(body.title,'Receptor no autorizado');assert.match(body.message,/receptor detectado no coincide.*cuentas autorizadas/i);assert.match(body.message,/error de lectura/i);assert.match(body.message,/¿Aún quieres reportar el pago\?/);assert.equal(created.length,beforeRecipientMismatch,'La alerta precisa debe preguntar antes de crear el reporte.');
  response=await handler(event({...mismatchPayload,uncertaintyAcknowledged:true}));body=parse(response);
  assert.equal(response.statusCode,200,JSON.stringify(body));assert.equal(created.length,beforeRecipientMismatch+1);assert.equal(body.uncertaintyAcknowledged,true);assert.equal(body.reviewDeadlineHours,72);assert.equal(created.at(-1)['Alerta Aceptada por Propietario'],true);assert.match(created.at(-1)['Alertas Presentadas'],/receptor detectado no coincide/i);

  historicalFinancialDuplicate=true;
  const reportsBeforeFinancialDuplicate=created.length;
  response=await handler(event({ownerId:'recABCDEFGHIJKLMN',submissionId:'submission-financial-duplicate-001',mode:'USD',amount:85,enteredCurrency:'USD',reference:'EXACT-FIN-001',bank:'Zelle',method:'ZELLE',transactionDate:'2026-08-12',transactionDateSource:'PROOF_EXTRACTED',dateAttestation:zelleDateAttestation,uncertaintyAcknowledged:true,attachment:{name:'otro-archivo.png',type:'image/png',base64:png.toString('base64')}}));body=parse(response);
  assert.equal(response.statusCode,409,JSON.stringify(body));assert.equal(body.duplicateType,'Referencia financiera exacta');assert.equal(body.duplicateLevel,'confirmed');
  assert.equal(created.length,reportsBeforeFinancialDuplicate,'Una coincidencia financiera exacta debe pedir confirmación antes de crear el reporte.');
  historicalFinancialDuplicate=false;

  historicalExactDuplicate=true;
  const reportsBeforeExactDuplicate=created.length;
  const exactDuplicatePayload={ownerId:'recABCDEFGHIJKLMN',submissionId:'submission-exact-duplicate-001',mode:'USD',amount:85,enteredCurrency:'USD',reference:'EXACT-001',bank:'Zelle',method:'ZELLE',uncertaintyAcknowledged:true,attachment:{name:'repetido.png',type:'image/png',base64:png.toString('base64')}};
  response=await handler(event(exactDuplicatePayload));body=parse(response);
  assert.equal(response.statusCode,409,JSON.stringify(body));
  assert.equal(body.duplicateLevel,'confirmed');assert.equal(body.canSubmitForReview,true);assert.match(body.message,/No se creó ningún reporte/i);
  assert.equal(created.length,reportsBeforeExactDuplicate,'El primer intento de duplicado exacto no puede crear un reporte.');

  response=await handler(event({...exactDuplicatePayload,duplicateReviewRequested:true}));body=parse(response);
  assert.equal(response.statusCode,200,JSON.stringify(body));assert.equal(body.duplicateReview,true);assert.equal(body.reviewDeadlineHours,72);
  assert.match(body.message,/no cambia tu saldo ni tu acceso/i);assert.equal(created.length,reportsBeforeExactDuplicate+1);
  assert.equal(created.at(-1)['Estado de Procesamiento'],'Pendiente de administrador');assert.equal(created.at(-1)['Nivel de Duplicado'],'confirmed');
  historicalExactDuplicate=false;

  console.log('PUBLIC_REPORT_PAYMENT_SMART_OK');
})().catch(error=>{console.error(error);process.exit(1)});
