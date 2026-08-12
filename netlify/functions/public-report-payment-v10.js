'use strict';

const crypto=require('crypto');
const legacy=require('./public-report-payment');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {decodeAttachment}=require('./_shared/_payment_report_attachment');
const {verifyPrefillAttestation}=require('./_shared/_payment_prefill_attestation');
const {createProofStore}=require('./_shared/_payment_proof_store');
const {connectLambdaEvent}=require('./_shared/_blobs_compat');
const {airtableCreateRecord,airtableGetRecord,TABLES,money}=require('./_shared/_access_control');
const {parseAmountInput,resolveAmount}=require('../../payment-report-intelligence');
const {loadLastGood}=require('./_shared/_bcv_store');
const {sanitizeReference,cleanPlainText,deepEscapeStrings}=require('./_shared/_security_utils');
const {todayCaracasISO}=require('./_shared/_payment_date_resolver');

const ALLOWED_MODES=new Set(['USD','Bs BCV']);
const ALLOWED_ENTERED_CURRENCIES=new Set(['USD','BS']);
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff','X-VLA-Payment-Validation':'v10',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clean(value){return String(value??'').trim()}
function safeSubmissionId(value){return/^[A-Za-z0-9_-]{8,100}$/.test(clean(value))?clean(value):crypto.randomUUID()}
function reviewRequestHash(attachmentSha,submissionId){return crypto.createHash('sha256').update(`VLA_REVIEW_V10|${attachmentSha}|${submissionId}`).digest('hex')}
function normalizedAnalysisSummary(payload={}){const a=payload.analysis||{};return{method:clean(a.method),bank:clean(a.bank_or_platform),amount:Number(a.amount)||0,currency:clean(a.currency),date:clean(a.transaction_date),reference:clean(a.reference),phone:clean(a.recipient_phone),email:clean(a.recipient_email),account:clean(a.recipient_account_visible),document:clean(a.recipient_document),binanceId:clean(a.recipient_binance_id)}}
async function officialRate(clientRate){const stored=await loadLastGood().catch(()=>null),official=Number(stored?.rate||0),supplied=Number(clientRate||0);if(official>0)return{rate:official,source:stored?.source||'BCV persistida'};if(supplied>0&&supplied<1000000)return{rate:supplied,source:'BCV recibida del portal'};return{rate:0,source:'No disponible'}}
async function actualHistoricalDuplicate(identity){try{return await legacy.findHistoricalFileDuplicate(identity)}catch(_){return{isDuplicate:false,possibleDuplicate:false,certainty:'NONE',type:''}}}
async function createReviewOnlyReport({event,body,attachment,identity,attestation,duplicateConfirmed=false}={}){
 const ownerId=clean(body.ownerId),mode=clean(body.mode),enteredCurrency=clean(body.enteredCurrency).toUpperCase(),amount=parseAmountInput(body.amount),submissionId=safeSubmissionId(body.submissionId);
 if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
 if(!ALLOWED_MODES.has(mode)||!ALLOWED_ENTERED_CURRENCIES.has(enteredCurrency)||!(amount>0))return json(400,{message:'Los datos esenciales del reporte no son válidos.'});
 const rateInfo=await officialRate(body.rate);if((mode==='Bs BCV'||enteredCurrency==='BS')&&!(rateInfo.rate>0))return json(400,{message:'La tasa BCV no está disponible. Intente nuevamente más tarde.'});
 const resolved=resolveAmount({amount,enteredCurrency,rate:rateInfo.rate});if(!resolved.ok||!(resolved.amountUsdRef>0))return json(400,{message:'El monto convertido no es válido.'});
 const owner=await airtableGetRecord(TABLES.propietarios,ownerId),ownerFields=owner?.fields||{},trusted=attestation.payload,analysis=normalizedAnalysisSummary(trusted),reference=sanitizeReference(body.reference||analysis.reference)||`REVISION-${submissionId.slice(-12)}`,bank=clean(analysis.bank||body.bank||'Verificación VLA'),reportTimestamp=new Date().toISOString();
 const reasonCode=trusted.duplicate?.certainty==='CONFIRMED'?'DUPLICATE_CONFIRMED':clean(trusted.recipient?.reasonCode||'ADMIN_REVIEW');
 const usdEq=money(resolved.amountUsdRef),amountBs=mode==='Bs BCV'?money(usdEq*rateInfo.rate):(enteredCurrency==='BS'?money(amount):0),proofStore=createProofStore(),requestSha=reviewRequestHash(identity.sha256,submissionId),reservation=await proofStore.reserveIdentity({attachmentSha:requestSha,requestId:submissionId,ownerId});
 if(reservation.idempotent)return json(200,{success:true,idempotent:true,reportId:reservation.reportId,message:'Este reporte ya había sido recibido correctamente y continúa en revisión administrativa.'});
 if(!reservation.acquired)return json(409,{success:false,duplicateSubmission:true,message:'Este mismo envío ya está siendo procesado. No es necesario reportarlo nuevamente.'});
 const proof=await legacy.storeEncryptedProof(`review-v10-${submissionId}`,attachment,identity,proofStore);
 const duplicateType=clean(trusted.duplicate?.type),duplicateIds=Array.isArray(trusted.duplicate?.matchIds)?trusted.duplicate.matchIds:[],ownerConfirmed=duplicateConfirmed===true;
 const context=[
  'VLA PAYMENT VALIDATION V10',
  'Revisión administrativa obligatoria: SÍ',
  `Motivo: ${reasonCode}`,
  `Duplicado confirmado: ${duplicateConfirmed?'SÍ':'NO'}`,
  duplicateConfirmed?'Propietario advertido y confirmó continuar: SÍ':'',
  duplicateType?`Tipo de coincidencia: ${duplicateType}`:'',
  duplicateIds.length?`Reportes/pagos relacionados: ${duplicateIds.join(', ')}`:'',
  `ID de envío: ${submissionId}`,
  body.observations?`Observación propietario: ${cleanPlainText(body.observations,300)}`:''
 ].filter(Boolean).join('\n');
 const detectedCurrency=analysis.currency||(enteredCurrency==='BS'?'VES':'USD');
 const fields={
  'Propietario que Reporta':[ownerId],'Monto Reportado':usdEq,Referencia:reference,Estado:'Pendiente','Fecha del Reporte':todayCaracasISO(),'Forma de Pago Reportada':mode,'Equivalente USD Reportado':usdEq,'Estado Acceso al Reportar':String(ownerFields['Estado Acceso Portón']||'Sin configurar'),'Casa al Reportar':Number(ownerFields.Casa||0),'Fecha y Hora del Reporte':reportTimestamp,'Moneda Ingresada':enteredCurrency==='BS'?'VES':'USD','Monto Ingresado':amount,'Fuente Tasa BCV Reporte':rateInfo.source,'Archivo Obligatorio':true,'Estado de Procesamiento':'Pendiente de administrador','Resultado Validación':duplicateConfirmed?'Duplicado confirmado · revisión solicitada':'Revisión manual urgente','Decisión Administrativa':'Pendiente','Banco Reportado':bank,'Observaciones Reportadas':context,
  'Normalized Analysis JSON':JSON.stringify({stage:'prefill-v10-attested',analysis:trusted.analysis,recipient:trusted.recipient,duplicate:trusted.duplicate,ownerConfirmedDuplicate:ownerConfirmed}),
  'Método Detectado':analysis.method,'Banco o Plataforma Detectada':bank,'Moneda Detectada':detectedCurrency,'Monto Detectado':analysis.amount||amount,'Fecha Operación Detectada':analysis.date||todayCaracasISO(),'Referencia Detectada':analysis.reference||reference,
  'Posible Duplicado':Boolean(duplicateConfirmed||trusted.duplicate?.certainty==='POSSIBLE'),'Tipo de Coincidencia':duplicateType||clean(trusted.duplicate?.certainty),'Detalle de Coincidencia':JSON.stringify({certainty:trusted.duplicate?.certainty||'NONE',matchIds:duplicateIds,ownerConfirmedDuplicate:ownerConfirmed}),
  'Comprobante Blob Key':proof.key,'Comprobante Nombre Original':attachment.filename,'Comprobante MIME':attachment.contentType,'Comprobante Bytes':attachment.size,'Hash SHA-256':identity.sha256,'Hash Perceptual':identity.visualHash||''
 };
 if(mode==='Bs BCV'){fields['Monto Reportado Bs']=amountBs;fields['Tasa BCV Reporte']=rateInfo.rate}
 const report=await airtableCreateRecord(TABLES.reportes,fields);await proofStore.completeIdentity({reservation,reportId:report.id}).catch(()=>null);
 const access=legacy.pendingReportAccessDecision(report.id);
 console.info(JSON.stringify({event:'VLA_PAYMENT_REPORT_V10_ADMIN_REVIEW',reportId:report.id,ownerId,duplicateConfirmed,reasonCode,submissionId}));
 return json(200,deepEscapeStrings({success:true,reviewRequired:true,duplicateConfirmed,message:duplicateConfirmed?'Reporte recibido. Ya sabemos que este comprobante fue utilizado anteriormente. Como confirmaste continuar, quedó en revisión administrativa y será revisado en un plazo no mayor de 72 horas.':'Reporte recibido. Quedó en revisión administrativa y será revisado en un plazo no mayor de 72 horas. No necesitas reportarlo nuevamente.',reportId:report.id,access}));
}

const handler=async event=>{
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return json(400,{message:'Solicitud inválida.'})}
 const paymentChannel=clean(body.paymentChannel||'DIGITAL').toUpperCase();if(paymentChannel!=='DIGITAL')return legacy.handler(event);
 const attachment=decodeAttachment(body.attachment);if(!attachment)return json(400,{message:'Debe adjuntar el comprobante antes de enviar el reporte.'});
 connectLambdaEvent(event);
 let identity;try{identity=await legacy.attachmentIdentity(attachment)}catch(error){return json(400,{message:'No pudimos preparar el comprobante para validación.',detail:clean(error.code||error.message)})}
 const attestation=verifyPrefillAttestation(body.prefillAttestation,{ownerId:body.ownerId,attachmentSha:identity.sha256});
 if(!attestation.ok)return json(409,{success:false,prefillRequired:true,message:'La validación previa del comprobante venció o no coincide con el archivo. Vuelve a seleccionar el comprobante para analizarlo nuevamente.',reason:attestation.reason});
 const recipientStatus=clean(attestation.payload?.recipient?.status),duplicateCertainty=clean(attestation.payload?.duplicate?.certainty),confirmedByOwner=body.confirmDuplicateReview===true;
 if(recipientStatus==='REJECTED')return json(422,{success:false,rejected:true,reasonCode:attestation.payload.recipient.reasonCode,message:'El pago no puede reportarse automáticamente porque el receptor visible no corresponde a un receptor autorizado. Revisa los datos del destinatario y realiza el pago únicamente a una cuenta autorizada.'});
 let currentDuplicate={isDuplicate:false};if(confirmedByOwner||duplicateCertainty!=='CONFIRMED')currentDuplicate=await actualHistoricalDuplicate(identity);
 const duplicateConfirmed=duplicateCertainty==='CONFIRMED'||currentDuplicate.isDuplicate===true;
 if(duplicateConfirmed&&!confirmedByOwner)return json(409,{success:false,duplicate:true,duplicateConfirmed:true,canContinueToReview:true,message:'Este comprobante ya fue utilizado en otro reporte de pago. Si consideras que existe una razón válida, puedes enviarlo igualmente para revisión administrativa. El pago no será aprobado automáticamente.'});
 const needsReview=duplicateConfirmed||recipientStatus!=='VERIFIED'||duplicateCertainty==='POSSIBLE';
 if(needsReview)return createReviewOnlyReport({event,body,attachment,identity,attestation,duplicateConfirmed});
 const response=await legacy.handler(event);
 if(Number(response.statusCode)===409){let data={};try{data=JSON.parse(response.body||'{}')}catch(_){}if(data.duplicate===true)return json(409,{...data,duplicateConfirmed:true,canContinueToReview:true,message:'Este comprobante ya fue utilizado o está siendo procesado. Si existe una razón válida para volver a reportarlo, puedes continuar y quedará en revisión administrativa.'},response.headers||{})}
 return response;
};

exports.handler=withAirtableUsage('public-report-payment-v10',handler);
exports.createReviewOnlyReport=createReviewOnlyReport;
exports.reviewRequestHash=reviewRequestHash;
exports.normalizedAnalysisSummary=normalizedAnalysisSummary;
