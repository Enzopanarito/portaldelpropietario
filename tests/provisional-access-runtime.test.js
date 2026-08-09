'use strict';

const assert=require('assert');
const runtimeModule=require('../netlify/functions/_shared/_provisional_access_runtime');

const REPORT_ID='recBBBBBBBBBBBBBB';
const OWNER_ID='recAAAAAAAAAAAAAA';
function exactResult(){return{result:{decision:{preliminaryMatch:true,requiresAdminDecision:true,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,reasons:['ADMIN_DECISION_REQUIRED'],processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente'},snapshot:{schemaVersion:2,balanceEngineVersion:5,cacheValid:true,automaticEligibility:true,paymentsAfterCutoff:[],snapshotId:'BALANCE_SNAPSHOT_V2|'+'a'.repeat(64)}}}}
function report(overrides={}){return{id:REPORT_ID,fields:{Estado:'Pendiente','Propietario que Reporta':[OWNER_ID],'Estado Acceso al Reportar':'Limitado','Habilitación Provisional Aplicada':false,'Pago Definitivo Creado':false,...overrides}}}
function owner(overrides={}){return{id:OWNER_ID,fields:{'Estado Acceso Portón':'Limitado','MKJ User ID':'123','MKJ Email':'owner@example.com','Reporte Habilitante Actual':[],'Acceso Habilitado Provisionalmente':false,'Tipo de Habilitación':'',...overrides}}}
function dependencies({mode='Manual',config={},reportRecord=report(),ownerRecord=owner(),owners=[],syncResult={estado:'Limitado'}}={}){
 const calls={get:[],patch:[],mkj:[],sync:[]};
 const deps={
  getAccessMode:async()=>({mode,record:{fields:{'Automatic Provisional Access Enabled':true,'Provisional Access Duration Hours':24,'Auto Relimit After Expiration':true,...config}}}),
  getRecord:async(table,id)=>{calls.get.push({table,id});return id===REPORT_ID?reportRecord:ownerRecord},
  patchRecord:async(table,id,fields)=>{calls.patch.push({table,id,fields});return{id,fields}},
  listAll:async()=>owners,
  syncOwnerAccess:async(id,options)=>{calls.sync.push({id,options});return syncResult},
  mkjSetMemberStatus:async(id,action,options)=>{calls.mkj.push({id,action,options});return{status:200}},
  nowCaracas:()=> '02/08/2026, 05:20:00 p. m.',
  tables:{reportes:'Reportes de Pago',propietarios:'Propietarios'},
  accessModeAuto:'Automático'
 };
 return{deps,calls};
}

(async()=>{
 {
  const{deps,calls}=dependencies({mode:'Manual'}),runtime=runtimeModule.createRuntime(deps);
  const result=await runtime.maybeApply({reportId:REPORT_ID,automationResult:exactResult(),now:new Date('2026-08-02T21:20:00.000Z')});
  assert.strictEqual(result.skipped,true);assert.strictEqual(result.reason,'MANUAL_MODE');assert.strictEqual(calls.mkj.length,0);assert.strictEqual(calls.patch.length,0);assert.strictEqual(calls.get.length,0);
 }
 {
  const{deps,calls}=dependencies({mode:'Automático'}),runtime=runtimeModule.createRuntime(deps);
  const result=await runtime.maybeApply({reportId:REPORT_ID,automationResult:exactResult(),now:new Date('2026-08-02T21:20:00.000Z')});
  assert.strictEqual(result.applied,true);assert.strictEqual(result.expiresAt,'2026-08-03T21:20:00.000Z');assert.strictEqual(calls.mkj.length,1);assert.strictEqual(calls.mkj[0].action,'enable');
  const ownerPatch=calls.patch.find(item=>item.id===OWNER_ID).fields,reportPatch=calls.patch.find(item=>item.id===REPORT_ID).fields;
  assert.strictEqual(ownerPatch['Acceso Habilitado Provisionalmente'],true);assert.strictEqual(ownerPatch['Estado Acceso Portón'],'Habilitado');assert.deepStrictEqual(ownerPatch['Reporte Habilitante Actual'],[REPORT_ID]);assert.strictEqual(ownerPatch['Pago Pendiente de Revisión'],true);
  assert.strictEqual(reportPatch['Habilitación Provisional Aplicada'],true);assert.match(reportPatch['MKJ Operation ID'],/^PROVISIONAL\|[a-f0-9]{64}$/);assert.strictEqual(reportPatch['Estado de Procesamiento'],'Pendiente de administrador');
  for(const forbidden of ['Deuda Anterior','Deuda Anterior USD','Deuda Anterior Bs Ref','Monto Pagado','Monto Pagado Bs'])assert(!Object.prototype.hasOwnProperty.call(ownerPatch,forbidden)&&!Object.prototype.hasOwnProperty.call(reportPatch,forbidden));
 }
 {
  const result=exactResult();result.result.decision.reasons=['PARTIAL_DUPLICATE_REVIEW'];
  const{deps,calls}=dependencies({mode:'Automático'}),runtime=runtimeModule.createRuntime(deps),answer=await runtime.maybeApply({reportId:REPORT_ID,automationResult:result});
  assert.strictEqual(answer.skipped,true);assert.strictEqual(answer.reason,'REPORT_NOT_EXACT');assert.strictEqual(calls.mkj.length,0);
 }
 {
  const activeOwner=owner({'Acceso Habilitado Provisionalmente':true,'Reporte Habilitante Actual':[REPORT_ID],'Vencimiento Habilitación Provisional':'2026-08-02T20:00:00.000Z','Tipo de Habilitación':'Provisional por comprobante'}),rejected=report({Estado:'Rechazado','Vencimiento Habilitación Provisional':'2026-08-02T20:00:00.000Z'});
  const{deps,calls}=dependencies({mode:'Manual',owners:[activeOwner],ownerRecord:activeOwner,reportRecord:rejected}),runtime=runtimeModule.createRuntime(deps),answer=await runtime.sweep({now:new Date('2026-08-02T21:00:00.000Z')});
  assert.strictEqual(answer.skipped,true);assert.strictEqual(answer.reason,'MANUAL_MODE');assert.strictEqual(calls.sync.length,0);assert.strictEqual(calls.patch.length,0);
 }
 {
  const activeOwner=owner({'Acceso Habilitado Provisionalmente':true,'Reporte Habilitante Actual':[REPORT_ID],'Vencimiento Habilitación Provisional':'2026-08-02T20:00:00.000Z','Tipo de Habilitación':'Provisional por comprobante'}),rejected=report({Estado:'Rechazado','Vencimiento Habilitación Provisional':'2026-08-02T20:00:00.000Z'});
  const{deps,calls}=dependencies({mode:'Automático',owners:[activeOwner],ownerRecord:activeOwner,reportRecord:rejected}),runtime=runtimeModule.createRuntime(deps),answer=await runtime.sweep({now:new Date('2026-08-02T21:00:00.000Z')});
  assert.strictEqual(answer.success,true);assert.strictEqual(calls.sync.length,1);assert.strictEqual(calls.sync[0].id,OWNER_ID);const cleanup=calls.patch.find(item=>item.id===OWNER_ID).fields;assert.strictEqual(cleanup['Acceso Habilitado Provisionalmente'],false);assert.deepStrictEqual(cleanup['Reporte Habilitante Actual'],[]);assert.strictEqual(cleanup['Pago Pendiente de Revisión'],false);
 }
 console.log('PROVISIONAL_ACCESS_RUNTIME_OK');
})().catch(error=>{console.error(error);process.exitCode=1});
