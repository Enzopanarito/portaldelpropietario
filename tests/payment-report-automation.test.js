'use strict';
const assert=require('assert');
const automation=require('../netlify/functions/_shared/_payment_report_automation');

(async()=>{
 const reportId='rec12345678901234',patched=[];
 const baseResult={ok:true,processingState:'Aprobación automática autorizada',resultValidation:'Coincidencia exacta verificada',automaticApproval:true,canCreatePayment:true,canEnableAccess:false,financialFingerprint:'f'.repeat(64),analysis:{normalized:{confidence:0.99,method:'ZELLE',amount:85,currency:'USD',reference:'REF1'},resolutionSource:'primary',rawSecondary:''},snapshot:{snapshotId:'BALANCE_SNAPSHOT_V2|x',schemaVersion:2,requiredUsdAccount:85,requiredBsAccount:0,source:'ControlVersiones'},duplicate:{isDuplicate:false,possibleDuplicate:false,type:'Sin coincidencia'},decision:{automaticApproval:true,reasons:['DETERMINISTIC_AUTOMATIC_APPROVAL']}};
 let executions=0;
 const processor=automation.createPaymentReportAutomation({
  loadBundle:async()=>({report:{id:reportId}}),
  orchestrator:{run:async()=>baseResult},
  patchReport:async(id,fields)=>patched.push({id,fields}),
  executeApproval:async()=>{executions+=1;return{success:true,paymentId:'recPAYMENT0000001'}}
 });
 const result=await processor.process(reportId,{});
 assert.strictEqual(result.automatic,true);assert.strictEqual(executions,1);assert.strictEqual(patched[0].fields['Decisión Administrativa'],'Aprobación automática');assert.strictEqual(patched[0].fields['Validación Realizada Por'],'Motor determinístico');
 const manualPatches=[];
 const manual=automation.createPaymentReportAutomation({loadBundle:async()=>({report:{id:reportId}}),orchestrator:{run:async()=>({...baseResult,automaticApproval:false,canCreatePayment:false,processingState:'Pendiente de administrador'})},patchReport:async(id,fields)=>manualPatches.push({id,fields}),executeApproval:async()=>{throw new Error('No debe ejecutarse.')}});
 const manualResult=await manual.process(reportId,{});assert.strictEqual(manualResult.automatic,false);
 assert.strictEqual(Object.prototype.hasOwnProperty.call(manualPatches[0].fields,'Decisión Administrativa'),false,'El análisis manual no puede sobrescribir una decisión administrativa existente.');
 assert.strictEqual(Object.prototype.hasOwnProperty.call(manualPatches[0].fields,'Validación Realizada Por'),false,'El análisis manual no puede atribuirse una aprobación.');
 const fallbackFields=automation.resultFields({...baseResult,automaticApproval:false,analysis:{...baseResult.analysis,normalized:{...baseResult.analysis.normalized,transaction_date:null}}},{fields:{'Fecha Operación Detectada':'2026-08-15','Fuente Fecha Operación':'UNDETERMINED','Confianza Fecha Operación':'LOW','Fecha Requiere Revisión':true,'Evidencia Fecha Operación':'Fecha provisional del reporte.'}});
 assert.strictEqual(fallbackFields['Fecha Operación Detectada'],'2026-08-15','El análisis posterior no puede borrar la fecha provisional del reporte.');
 assert.strictEqual(fallbackFields['Fuente Fecha Operación'],'UNDETERMINED');assert.strictEqual(fallbackFields['Fecha Requiere Revisión'],true);assert.strictEqual(fallbackFields['Evidencia Fecha Operación'],'Fecha provisional del reporte.','La evidencia previa debe preservarse literalmente si el servidor no confirmó una fecha nueva.');
 console.log('PAYMENT_REPORT_AUTOMATION_OK');
})().catch(error=>{console.error(error);process.exit(1)});
