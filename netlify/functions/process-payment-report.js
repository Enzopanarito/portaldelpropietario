const {withAirtableUsage}=require('./_shared/_airtable_meter');

// Decisiones administrativas de reportes de pago.
// Solo una aprobación materializa un pago. Rechazos, solicitudes de información
// y duplicados nunca recalculan saldo ni acceso. La relación Reporte -> Pago y la
// guardia persistente permiten reanudar una finalización sin crear un segundo pago.

'use strict';

const {requireAdmin}=require('./_shared/_auth');
const {json,money,airtableGetRecord,airtableListAll,airtableCreateRecord,airtablePatchRecord,syncOwnerAccess,TABLES}=require('./_shared/_access_control');
const {createAndSendReceipt}=require('./_shared/_receipt_service');
const {begin,setState}=require('./_shared/_operation_guard');
const { hashPayload } = require('./_shared/_idempotency_blobs');
const {ensureFinancialWritesAllowed}=require('./_shared/_financial_write_lock');
const {safeDisplayText,deepEscapeStrings}=require('./_shared/_security_utils');
const adminDecision=require('./_shared/_payment_admin_decision');

const TRANSIENT_PROCESSING_FAILURES=Object.freeze(new Set(['PROCESSING_BUSY','PROCESSING_NOT_FOUND','PROCESSING_CAS_CONFLICT','PROCESSING_LEASE_LOST']));

function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''))}
function selectName(value){return value&&typeof value==='object'&&value.name?value.name:String(value||'')}
function linkedPaymentForReport(payments,reportId){return(payments||[]).find(payment=>Array.isArray(payment?.fields?.['Reporte de Pago Origen'])&&payment.fields['Reporte de Pago Origen'].includes(reportId))||null}
async function findExistingPayment(reportId){return linkedPaymentForReport(await airtableListAll(TABLES.pagos),reportId)}
function operationResponse(result){
 if(result.reason==='running')return json(409,{success:false,protected:true,message:'Este reporte ya está siendo procesado. Espere unos segundos y actualice el panel.'});
 if(result.reason==='partial')return json(409,{success:false,protected:true,partial:true,paymentId:result.marker?.resultId||null,message:'Existe una operación histórica parcial protegida. Revise el pago relacionado antes de continuar.'});
 if(result.reason==='conflict')return json(409,{success:false,protected:true,idempotencyConflict:true,message:'Este reporte ya tiene otra decisión administrativa en curso o registrada. Actualice el panel antes de continuar.'});
 return json(200,{success:true,protected:true,decision:'already-processed',paymentId:result.marker?.resultId||null,message:'Esta decisión ya fue procesada. No se creó otro pago.'});
}
function adminId(auth,decisionSource){return decisionSource==='automatic'?'AUTOPILOT':safeDisplayText(auth.claims?.jti||'ADMIN',120)}
function audit(fields,context){return adminDecision.appendAudit(fields['Log de Auditoría'],context)}
function appendInformationRequest(existing,reason,at){const current=String(existing||'').trim(),entry=`[${at}] ${reason}`;return[current,entry].filter(Boolean).join('\n').slice(-9000)}
function processingFailureCode(fields={}){
 const direct=safeDisplayText(fields['AI Failure Reason']||'',120).trim().toUpperCase();
 if(TRANSIENT_PROCESSING_FAILURES.has(direct))return direct;
 const detail=safeDisplayText(fields['Último Error de Procesamiento']||'',500).trim().toUpperCase(),match=/^([A-Z0-9_]+)/.exec(detail);
 return match&&TRANSIENT_PROCESSING_FAILURES.has(match[1])?match[1]:'';
}
function terminalProcessingCleanup(fields={}){
 const code=processingFailureCode(fields);
 return code?{code,patch:{'AI Failure Reason':null,'Último Error de Procesamiento':null,'Processing Lock':false,'Processing Lease Expires At':null}}:{code:'',patch:{}};
}
function terminalAudit(fields,context){
 const cleanup=terminalProcessingCleanup(fields),base=fields['Log de Auditoría'];
 const normalized=cleanup.code?adminDecision.appendAudit(base,{action:'clear_transient_processing_failure',adminId:context.adminId,reason:cleanup.code,result:'terminal-decision-authoritative',at:context.at}):base;
 return adminDecision.appendAudit(normalized,context);
}
function terminalPatch(action,fields,{who,reason,now}){
 const duplicate=action==='mark_duplicate',cleanup=terminalProcessingCleanup(fields);
 return{...cleanup.patch,Estado:'Rechazado','Estado de Procesamiento':duplicate?'Duplicado detectado':'Rechazado','Resultado Validación':duplicate?'Duplicado':selectName(fields['Resultado Validación'])||'Revisión manual urgente','Decisión Administrativa':duplicate?'Marcado duplicado':'Rechazado','Validación Realizada Por':'Administrador','Administrador que Revisó':who,'Fecha Revisión':now,...(reason?{'Motivo del Rechazo':reason}:{}),'Posible Duplicado':duplicate||fields['Posible Duplicado']===true,...(duplicate?{'Nivel de Duplicado':'confirmed'}:{}),'Log de Auditoría':terminalAudit(fields,{action,adminId:who,reason,result:duplicate?'duplicate-confirmed':'rejected',at:now})};
}

const handler=async function(event){
 const auth=requireAdmin(event);if(!auth.ok)return auth.response;
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){body={}}
 const reportId=String(body.reportId||'').trim(),input=adminDecision.validateDecisionInput(body),decisionSource=body.decisionSource==='automatic'?'automatic':'admin';
 if(!validRecordId(reportId))return json(400,{success:false,message:'Reporte inválido.'});
 if(!input.ok)return json(400,{success:false,message:input.message});
 if(decisionSource==='automatic'&&input.action!=='approve')return json(403,{success:false,message:'El motor automático solo puede ejecutar una aprobación determinística.'});
 if(decisionSource==='automatic'){
  const evidence=body.automationEvidence||{};
  if(!String(evidence.snapshotId||'').startsWith('BALANCE_SNAPSHOT_V2|')||!/^[a-f0-9]{64}$/i.test(String(evidence.fingerprint||''))||Number(evidence.confidence||0)<0.95)return json(403,{success:false,message:'La aprobación automática no contiene evidencia verificable.'});
 }

 let operation=null,paymentId='',paymentCreated=false,writeStage=0;
 try{
  if(input.approval){const lock=await ensureFinancialWritesAllowed();if(!lock.ok)return lock.response}
  let report=await airtableGetRecord(TABLES.reportes,reportId),fields=report.fields||{},ownerId=(fields['Propietario que Reporta']||[])[0];
  if(!validRecordId(ownerId))return json(400,{success:false,message:'El reporte no tiene propietario válido.'});
  const status=selectName(fields.Estado||'Pendiente'),who=adminId(auth,decisionSource),reviewedAt=new Date().toISOString();
  if(status==='Confirmado')return json(200,{success:true,decision:'already-confirmed',message:'Este reporte ya estaba confirmado. No se creó otro pago.',report:deepEscapeStrings(report)});
  if(status==='Rechazado')return json(200,{success:true,decision:'already-rejected',message:'Este reporte ya estaba rechazado. No se hizo ningún cambio.',report:deepEscapeStrings(report)});

  if(input.action==='request_information'){
   const requestHistory=appendInformationRequest(fields['Solicitud de Información'],input.reason,reviewedAt),patched=await airtablePatchRecord(TABLES.reportes,reportId,{'Estado de Procesamiento':'Información solicitada','Decisión Administrativa':'Información solicitada','Validación Realizada Por':'Administrador','Administrador que Revisó':who,'Fecha Revisión':reviewedAt,'Solicitud de Información':requestHistory,'Fecha Solicitud Información':reviewedAt,'Notificación Propietario':input.reason,'Log de Auditoría':audit(fields,{action:input.action,adminId:who,reason:input.reason,result:'information-requested',at:reviewedAt})});
   return json(200,{success:true,decision:input.action,message:'Información solicitada. El reporte sigue pendiente y no se modificó saldo ni acceso.',report:deepEscapeStrings(patched)});
  }

  const effective=input.approval?adminDecision.effectivePayment(fields,input.corrections):null;
  if(input.approval&&!effective.ok)return json(409,{success:false,requiresCorrection:true,message:effective.message});
  if(input.action==='approve'){
   const blockers=adminDecision.normalApprovalBlockers(fields,{automatic:decisionSource==='automatic'});
   if(blockers.length)return json(409,{success:false,requiresException:true,blockers,message:'La aprobación normal está bloqueada por evidencia pendiente. Corrija los datos o use una excepción justificada.'});
  }
  if(input.action==='correct_and_approve'){
   const previewPatch=adminDecision.correctionPatch(fields,input.corrections,effective,input.reason),blockers=adminDecision.normalApprovalBlockers({...fields,...previewPatch}).filter(code=>code!=='VALIDATION_NOT_GREEN');
   if(blockers.length)return json(409,{success:false,requiresException:true,blockers,message:'La corrección no resuelve todas las alertas. Use una excepción justificada si verificó el comprobante.'});
  }

  const payloadHash=hashPayload({reportId,action:input.action,reason:input.reason,corrections:input.corrections,effective});
  const guard=await begin('PAYMENT_REPORT', reportId, { payloadHash, event });
  if(!guard.ok){
   if(guard.reason==='done'){report=await airtableGetRecord(TABLES.reportes,reportId).catch(()=>report);const finalStatus=selectName(report?.fields?.Estado);if(finalStatus==='Confirmado')return json(200,{success:true,decision:'already-confirmed',paymentId:guard.marker?.resultId||null,message:'Este reporte ya estaba confirmado. No se creó otro pago.'});if(finalStatus==='Rechazado')return json(200,{success:true,decision:'already-rejected',message:'Este reporte ya estaba rechazado. No se hizo ningún cambio.'})}
   return operationResponse(guard);
  }
  operation=guard.marker;

  if(input.terminal){
   const patched=await airtablePatchRecord(TABLES.reportes,reportId,terminalPatch(input.action,fields,{who,reason:input.reason,now:reviewedAt}));writeStage=1;
   let guardWarning=null;try{await setState(operation,'PAYMENT_REPORT',reportId,'DONE',reportId)}catch(error){guardWarning=safeDisplayText(error.message,500)}
   return json(200,{success:true,decision:input.action,message:input.action==='mark_duplicate'?'Reporte marcado como duplicado. No se modificó saldo ni acceso.':'Pago rechazado. No se modificó saldo ni acceso.',warning:guardWarning,report:deepEscapeStrings(patched),access:{unchanged:true}});
  }

  const correctionPatch=adminDecision.correctionPatch(fields,input.corrections,effective,input.reason);
  if(Object.keys(correctionPatch).length){report=await airtablePatchRecord(TABLES.reportes,reportId,{...correctionPatch,'Log de Auditoría':audit(fields,{action:'correction',adminId:who,reason:input.reason,corrections:input.corrections,result:'verified-before-approval',at:reviewedAt})});fields=report.fields||{...fields,...correctionPatch}}

  let payment=await findExistingPayment(reportId);
  if(payment){paymentId=payment.id||'';writeStage=1}
  else{
   const paymentFields={'Propietario que Paga':[ownerId],'Fecha de Pago':effective.transactionDate,'Forma de Pago':effective.mode,'Monto Pagado':effective.amountUsd,'Equivalente USD Aplicado':effective.amountUsd,'Moneda Recibida':effective.receivedCurrency,'Monto Recibido':effective.receivedAmount,'Fuente Tasa BCV':effective.mode==='USD'?'No aplica':'Tasa BCV del reporte','Reporte de Pago Origen':[reportId],Referencia:effective.reference,'Hash SHA-256':safeDisplayText(fields['Hash SHA-256']||'',64),'Hash Perceptual':safeDisplayText(fields['Hash Perceptual']||'',64),'Huella Financiera':safeDisplayText(fields['Huella Financiera']||'',64),'Fuente de Validación':decisionSource==='automatic'?'Automática':'Manual',Observaciones:safeDisplayText(fields['Observaciones Reportadas']||'',500)};
   if(effective.mode==='Bs BCV'){paymentFields['Monto Pagado Bs']=effective.amountBs;paymentFields['Tasa BCV Aplicada']=effective.rate}
   payment=await airtableCreateRecord(TABLES.pagos,paymentFields);paymentId=payment?.id||'';paymentCreated=true;writeStage=1;
  }
  if(!validRecordId(paymentId))throw new Error('Airtable no devolvió un pago definitivo válido.');

  const finalDecision=decisionSource==='automatic'?'Aprobación automática':input.action==='approve_exception'?'Aprobado por excepción':input.action==='correct_and_approve'?'Corregido y aprobado':'Aprobado',cleanup=terminalProcessingCleanup(fields);
  const patched=await airtablePatchRecord(TABLES.reportes,reportId,{...cleanup.patch,Estado:'Confirmado','Estado de Procesamiento':'Aprobado','Resultado Validación':'Coincidencia exacta verificada','Decisión Administrativa':finalDecision,'Validación Realizada Por':decisionSource==='automatic'?'Motor determinístico':'Administrador','Administrador que Revisó':who,'Fecha Revisión':reviewedAt,'Pago Definitivo Creado':true,'Pago Definitivo Relacionado':[paymentId],...(input.action==='approve_exception'&&input.reason?{'Motivo de Excepción':input.reason}:{}),'Log de Auditoría':terminalAudit(fields,{action:input.action,adminId:who,reason:input.reason,corrections:input.corrections,result:paymentCreated?'payment-created':'payment-reused-idempotently',paymentId,at:reviewedAt})});
  writeStage=2;

  let receipt=null;try{receipt=await createAndSendReceipt({ownerId,paymentId,mode:effective.mode,amountUsd:effective.amountUsd,amountBs:effective.amountBs,reference:effective.reference,concept:decisionSource==='automatic'?'Pago reportado y validado automáticamente':input.action==='approve_exception'?'Pago reportado y aprobado por excepción administrativa':'Pago reportado y aprobado por administración'})}catch(error){receipt={success:false,warning:safeDisplayText(error.message,500)}}
  let access=null;try{access=await syncOwnerAccess(ownerId,{reason:'Pago definitivo aprobado. Sincronización posterior a la creación idempotente del pago.',sendEmail:true})}catch(error){access={success:false,warning:safeDisplayText(error.message,500)}}
  let guardWarning=null;try{await setState(operation,'PAYMENT_REPORT',reportId,'DONE',paymentId)}catch(error){guardWarning=safeDisplayText(error.message,500)}
  const receiptSent=receipt?.email?.status==='Enviado',accessWarning=access?.success===false;
  return json(200,{success:true,decision:input.action,decisionSource,paymentCreated,message:accessWarning?'Pago confirmado. La sincronización del acceso requiere revisión.':receiptSent?'Pago confirmado, recibo enviado y acceso sincronizado.':'Pago confirmado y acceso sincronizado.',warning:guardWarning,report:deepEscapeStrings(patched),payment:deepEscapeStrings(payment),receipt:deepEscapeStrings(receipt),access:deepEscapeStrings(access),receiptPayload:{ownerId,paymentId,mode:effective.mode,amountUsd:effective.amountUsd,amountBs:effective.amountBs,reference:effective.reference}});
 }catch(error){
  if(operation)await setState(operation,'PAYMENT_REPORT',reportId,'ERROR',paymentId).catch(()=>null);
  return json(paymentId?503:500,{success:false,protected:true,recoverable:Boolean(paymentId),safeToRetry:Boolean(paymentId),paymentId:paymentId||null,message:paymentId?'El pago quedó vinculado al reporte, pero faltó finalizar un paso. Reintente la misma acción: el sistema reutilizará este pago y no creará otro.':'Error procesando reporte de pago. No se creó ningún pago.',detail:safeDisplayText(error.message,500),writeStage});
 }
};

exports.handler=withAirtableUsage('process-payment-report',handler);
exports.linkedPaymentForReport=linkedPaymentForReport;
exports.findExistingPayment=findExistingPayment;
exports.terminalPatch=terminalPatch;
exports.appendInformationRequest=appendInformationRequest;
exports.processingFailureCode=processingFailureCode;
exports.terminalProcessingCleanup=terminalProcessingCleanup;
exports.terminalAudit=terminalAudit;
