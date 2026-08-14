'use strict';
const assert=require('assert');
const Module=require('module');
const path=require('path');

const ownerId='rec'+'O'.repeat(14),approveId='rec'+'A'.repeat(14),rejectId='rec'+'R'.repeat(14),infoId='rec'+'I'.repeat(14),duplicateId='rec'+'D'.repeat(14),correctionId='rec'+'C'.repeat(14),exceptionId='rec'+'E'.repeat(14),blockedId='rec'+'B'.repeat(14),paymentId='rec'+'P'.repeat(14);
function fields(){return{Estado:'Pendiente','Propietario que Reporta':[ownerId],'Forma de Pago Reportada':'USD','Monto Reportado':50,'Equivalente USD Reportado':50,'Moneda Ingresada':'USD','Monto Ingresado':50,'Referencia Detectada':'REF-123','Banco o Plataforma Detectada':'Zelle','Método Detectado':'ZELLE','Fecha Operación Detectada':'2026-08-12','Fuente Fecha Operación':'PROOF_EXTRACTED','Confianza Fecha Operación':'HIGH','Fecha Requiere Revisión':false,'Archivo Obligatorio':true,'Posible Duplicado':false,'Nivel de Duplicado':'none','Clasificación Receptor':'CONFIRMED','Estado Transacción Detectado':'COMPLETED','Resultado Validación':'Coincide preliminarmente','Normalized Analysis JSON':'{"possible_visual_modification":false}'}}
const reports=new Map([[approveId,{id:approveId,fields:fields()}],[rejectId,{id:rejectId,fields:fields()}],[infoId,{id:infoId,fields:fields()}],[duplicateId,{id:duplicateId,fields:fields()}],[correctionId,{id:correctionId,fields:fields()}],[exceptionId,{id:exceptionId,fields:{...fields(),'Posible Duplicado':true,'Nivel de Duplicado':'confirmed','Resultado Validación':'Duplicado'}}],[blockedId,{id:blockedId,fields:{...fields(),'Clasificación Receptor':'PROBABLE','Resultado Validación':'Receptor probable'}}]]),payments=[];
let createCount=0,syncCount=0,failFinalPatchOnce=true,guardStates=[];
const originalLoad=Module._load;
Module._load=function(request,parent,isMain){
 if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','process-payment-report.js'))){
  if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
  if(request==='./_shared/_auth')return{requireAdmin:()=>({ok:true,claims:{jti:'ADMIN-TEST'}})};
  if(request==='./_shared/_access_control')return{
   json:(statusCode,body)=>({statusCode,body:JSON.stringify(body)}),money:value=>Math.round(Number(value||0)*100)/100,TABLES:{reportes:'Reportes',pagos:'Pagos'},
   airtableGetRecord:async(_table,id)=>reports.get(id),airtableListAll:async()=>payments,
   airtableCreateRecord:async(_table,paymentFields)=>{createCount+=1;const payment={id:paymentId,fields:paymentFields};payments.push(payment);return payment},
   airtablePatchRecord:async(_table,id,patch)=>{if(id===approveId&&patch.Estado==='Confirmado'&&failFinalPatchOnce){failFinalPatchOnce=false;throw new Error('fallo inyectado después de crear pago')}const current=reports.get(id),next={...current,fields:{...current.fields,...patch}};reports.set(id,next);return next},
   syncOwnerAccess:async()=>{syncCount+=1;return{success:true}}
  };
  if(request==='./_shared/_receipt_service')return{createAndSendReceipt:async()=>({success:true,email:{status:'Enviado'}})};
  if(request==='./_shared/_operation_guard')return{begin:async()=>({ok:true,marker:{id:'guard'}}),setState:async(_marker,_scope,_key,state,resultId)=>{guardStates.push({state,resultId});return{}}};
  if(request==='./_shared/_idempotency_blobs')return{hashPayload:()=> 'f'.repeat(64)};
  if(request==='./_shared/_financial_write_lock')return{ensureFinancialWritesAllowed:async()=>({ok:true})};
  if(request==='./_shared/_security_utils')return{safeDisplayText:(value,max)=>String(value||'').slice(0,max),deepEscapeStrings:value=>value};
 }
 return originalLoad.apply(this,arguments);
};
delete require.cache[require.resolve('../netlify/functions/process-payment-report')];
const processReport=require('../netlify/functions/process-payment-report');
Module._load=originalLoad;
const event=body=>({httpMethod:'POST',headers:{},body:JSON.stringify(body)});
const parse=response=>JSON.parse(response.body);

(async()=>{
 const rejected=await processReport.handler(event({reportId:rejectId,decision:'reject',reason:'Comprobante no corresponde al pago'}));assert.strictEqual(rejected.statusCode,200);assert.strictEqual(parse(rejected).access.unchanged,true);assert.strictEqual(syncCount,0,'Rechazar nunca puede sincronizar ni cambiar acceso.');assert.strictEqual(createCount,0);
 const requested=await processReport.handler(event({reportId:infoId,decision:'request_information',reason:'Necesitamos una referencia bancaria más legible'}));assert.strictEqual(requested.statusCode,200);assert.strictEqual(reports.get(infoId).fields.Estado,'Pendiente');assert.strictEqual(reports.get(infoId).fields['Estado de Procesamiento'],'Información solicitada');assert.strictEqual(createCount,0);assert.strictEqual(syncCount,0);
 assert.match(reports.get(infoId).fields['Solicitud de Información'],/referencia bancaria más legible/);assert(reports.get(infoId).fields['Fecha Solicitud Información']);
 const duplicate=await processReport.handler(event({reportId:duplicateId,decision:'mark_duplicate',reason:'Coincide el hash exacto con un reporte previo'}));assert.strictEqual(duplicate.statusCode,200);assert.strictEqual(reports.get(duplicateId).fields.Estado,'Rechazado');assert.strictEqual(reports.get(duplicateId).fields['Decisión Administrativa'],'Marcado duplicado');assert.strictEqual(createCount,0);assert.strictEqual(syncCount,0);
 const blocked=await processReport.handler(event({reportId:blockedId,decision:'approve'}));assert.strictEqual(blocked.statusCode,409);assert(parse(blocked).blockers.includes('RECIPIENT_PROBABLE'));assert.strictEqual(createCount,0);assert.strictEqual(syncCount,0);
 const interrupted=await processReport.handler(event({reportId:approveId,decision:'approve'}));assert.strictEqual(interrupted.statusCode,503);assert.strictEqual(parse(interrupted).safeToRetry,true);assert.strictEqual(createCount,1);assert.strictEqual(payments[0].fields['Reporte de Pago Origen'][0],approveId);assert(guardStates.some(item=>item.state==='ERROR'));
 const resumed=await processReport.handler(event({reportId:approveId,decision:'approve'}));assert.strictEqual(resumed.statusCode,200,JSON.stringify(parse(resumed)));assert.strictEqual(createCount,1,'Reanudar debe reutilizar el pago vinculado y nunca crear otro.');assert.strictEqual(parse(resumed).paymentCreated,false);assert.strictEqual(reports.get(approveId).fields.Estado,'Confirmado');assert.strictEqual(syncCount,1);assert(guardStates.some(item=>item.state==='DONE'&&item.resultId===paymentId));
 const corrected=await processReport.handler(event({reportId:correctionId,decision:'correct_and_approve',reason:'Referencia verificada contra comprobante',corrections:{reference:'REF-CORREGIDA'}}));assert.strictEqual(corrected.statusCode,200,JSON.stringify(parse(corrected)));assert.strictEqual(reports.get(correctionId).fields.Estado,'Confirmado');assert.strictEqual(reports.get(correctionId).fields.Referencia,'REF-CORREGIDA');assert.strictEqual(createCount,2);assert.strictEqual(syncCount,2);
 const exception=await processReport.handler(event({reportId:exceptionId,decision:'approve_exception',reason:'Duplicado descartado al verificar cuentas y operación original'}));assert.strictEqual(exception.statusCode,200,JSON.stringify(parse(exception)));assert.strictEqual(reports.get(exceptionId).fields['Decisión Administrativa'],'Aprobado por excepción');assert.strictEqual(createCount,3);assert.strictEqual(syncCount,3);
 assert.strictEqual(processReport.linkedPaymentForReport(payments,approveId).id,paymentId);
 console.log('PROCESS_PAYMENT_REPORT_V10_OK');
})().catch(error=>{console.error(error);process.exit(1)});
