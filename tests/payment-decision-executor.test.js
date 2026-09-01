'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const state=require('../netlify/functions/_payment_decision_state_machine');
const executorModule=require('../netlify/functions/_payment_decision_executor');

function report(overrides={}){return{id:'recReport1',fields:{'Propietario que Reporta':['recOwner1'],Estado:'Pendiente','Pago Definitivo Creado':false,'Forma de Pago Reportada':'USD','Equivalente USD Reportado':85,'Monto Reportado':85,Referencia:'REF-EXEC','Habilitación Provisional Aplicada':false,'MKJ Operation ID':'',...overrides}}}
function owner(overrides={}){return{id:'recOwner1',fields:{'Reporte Habilitante Actual':[],'Tipo de Habilitación':'',...overrides}}}
function decision(){return{preliminaryMatch:true,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,requiresAdminDecision:true,processingState:'Coincide preliminarmente',resultValidation:'Coincide preliminarmente'}}
function snapshot(){return{schemaVersion:2,balanceEngineVersion:5,cacheValid:true,automaticEligibility:true,paymentsAfterCutoff:[],snapshotId:'BALANCE_SNAPSHOT_V2|'+'a'.repeat(64)}}
function approval(){return state.authorizeReportApproval({report:report(),owner:owner(),adminId:'adminEnzo',decision:decision(),snapshot:snapshot(),snapshotValidation:{ok:true},now:new Date('2026-07-13T20:00:00.000Z')})}
function stagingEnv(){return{VLA_DATA_ENVIRONMENT:'staging',AIRTABLE_BASE_ID:executorModule.STAGING_BASE_ID,CONTEXT:'deploy-preview'}}
function productionEnv(){return{VLA_DATA_ENVIRONMENT:'production',AIRTABLE_BASE_ID:'app4nE4ReGRi2SuP2',CONTEXT:'production'}}
function harness(){
 const calls={payment:0,receiptRecord:0,receiptDeliver:0,access:0,relimit:0,audit:[]};
 const flags={receiptRecordFailures:0,receiptDeliveryFailures:0,accessFailures:0,relimitFailures:0,auditBeforeFailure:false,auditAfterFailure:false};
 const adapters={
  payment:{async createOnce(payload){calls.payment+=1;return{paymentId:'recPayment1',idempotencyKey:payload.idempotencyKey}}},
  receipt:{async recordOnce(payload){calls.receiptRecord+=1;if(flags.receiptRecordFailures-->0)throw Object.assign(new Error('No se pudo registrar recibo'),{code:'RECEIPT_TEMPORARY'});return{receiptId:'recReceipt1',recorded:true,emailSent:false,emailError:'SMTP temporal'}},async deliver(){calls.receiptDeliver+=1;if(flags.receiptDeliveryFailures-->0)throw Object.assign(new Error('Correo temporal'),{code:'SMTP_TEMPORARY'});return{sent:true}}},
  access:{async recalculate(){calls.access+=1;if(flags.accessFailures-->0)throw Object.assign(new Error('MKJ temporal'),{code:'MKJ_TEMPORARY'});return{success:true,status:'Habilitado'}},async relimitExact(){calls.relimit+=1;if(flags.relimitFailures-->0)throw Object.assign(new Error('MKJ temporal'),{code:'MKJ_TEMPORARY'});return{success:true,status:'Limitado'}}},
  audit:{async append(payload){calls.audit.push(payload);if(payload.phase==='BEFORE'&&flags.auditBeforeFailure)throw Object.assign(new Error('Auditoría no disponible'),{code:'AUDIT_DOWN'});if(payload.phase==='AFTER'&&flags.auditAfterFailure)throw Object.assign(new Error('Auditoría posterior no disponible'),{code:'AUDIT_AFTER_DOWN'});return{ok:true}}}
 };
 let tick=Date.parse('2026-07-13T20:00:00.000Z');const executor=executorModule.createExecutor({adapters,now:()=>new Date(tick++)});return{calls,flags,adapters,executor};
}

(async()=>{
 const simulation=harness(),simulated=await simulation.executor.executeNext(approval(),{mode:'simulate',env:productionEnv()});assert.strictEqual(simulated.action,'CREATE_PAYMENT_ONCE');assert.strictEqual(simulated.simulated,true);assert.strictEqual(simulated.executed,false);assert.strictEqual(simulation.calls.payment,0);assert.strictEqual(simulation.calls.audit.length,0);assert.strictEqual(simulated.machine.paymentId,null);
 await assert.rejects(()=>simulation.executor.executeNext(approval(),{mode:'production',env:productionEnv()}),error=>error.code==='PAYMENT_EXECUTION_MODE_INVALID');
 await assert.rejects(()=>simulation.executor.executeNext(approval(),{mode:'staging',confirmation:executorModule.STAGING_CONFIRMATION,env:productionEnv()}),error=>error.code==='PAYMENT_EXECUTION_PRODUCTION_BLOCKED');
 await assert.rejects(()=>simulation.executor.executeNext(approval(),{mode:'staging',confirmation:'wrong',env:stagingEnv()}),error=>error.code==='PAYMENT_EXECUTION_CONFIRMATION_REQUIRED');
 await assert.rejects(()=>simulation.executor.executeNext(approval(),{mode:'staging',confirmation:executorModule.STAGING_CONFIRMATION,env:{...stagingEnv(),AIRTABLE_BASE_ID:'appWRONG000000001'}}),error=>error.code==='PAYMENT_EXECUTION_STAGING_MISMATCH');

 const flow=harness();const options={mode:'staging',confirmation:executorModule.STAGING_CONFIRMATION,env:stagingEnv()};
 let machine=approval();let result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,true);assert.strictEqual(result.action,'CREATE_PAYMENT_ONCE');assert.strictEqual(result.executed,true);assert.strictEqual(result.machine.paymentId,'recPayment1');assert.strictEqual(flow.calls.payment,1);assert.strictEqual(flow.calls.audit.length,2);machine=result.machine;
 flow.flags.receiptRecordFailures=1;result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,false);assert.strictEqual(result.action,'CREATE_RECEIPT_RECORD_ONCE');assert.strictEqual(result.executed,false);assert.strictEqual(result.machine.paymentId,'recPayment1');assert.strictEqual(result.machine.state,'RECEIPT_RECORD_PENDING');assert.strictEqual(flow.calls.payment,1);assert.strictEqual(flow.calls.receiptRecord,1);machine=result.machine;
 result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,true);assert.strictEqual(result.action,'CREATE_RECEIPT_RECORD_ONCE');assert.strictEqual(result.machine.receiptId,'recReceipt1');assert.strictEqual(result.machine.receiptDeliveryStatus,'FAILED');assert.strictEqual(result.machine.state,'ACCESS_RECALC_PENDING');assert.strictEqual(flow.calls.payment,1);assert.strictEqual(flow.calls.receiptRecord,2);machine=result.machine;
 assert.deepStrictEqual(state.nextActions(machine),['DELIVER_RECEIPT_ONLY','RECALCULATE_ACCESS_ONLY']);assert.strictEqual(executorModule.nextAction(machine),'RECALCULATE_ACCESS_ONLY','El correo no puede bloquear el recálculo de acceso.');
 flow.flags.accessFailures=1;result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,false);assert.strictEqual(result.action,'RECALCULATE_ACCESS_ONLY');assert.strictEqual(result.machine.accessRecalculationStatus,'FAILED');assert.strictEqual(flow.calls.access,1);assert.strictEqual(flow.calls.receiptDeliver,0);assert.strictEqual(flow.calls.payment,1);machine=result.machine;
 result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,true);assert.strictEqual(result.action,'RECALCULATE_ACCESS_ONLY');assert.strictEqual(result.machine.accessRecalculationStatus,'DONE');assert.strictEqual(result.machine.state,'COMPLETED_RECEIPT_DELIVERY_PENDING');assert.strictEqual(flow.calls.access,2);machine=result.machine;
 flow.flags.receiptDeliveryFailures=1;result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,false);assert.strictEqual(result.action,'DELIVER_RECEIPT_ONLY');assert.strictEqual(result.machine.state,'COMPLETED_RECEIPT_DELIVERY_PENDING');assert.strictEqual(flow.calls.receiptDeliver,1);assert.strictEqual(flow.calls.payment,1);machine=result.machine;
 result=await flow.executor.executeNext(machine,options);assert.strictEqual(result.ok,true);assert.strictEqual(result.action,'DELIVER_RECEIPT_ONLY');assert.strictEqual(result.machine.state,'COMPLETED');assert.strictEqual(result.complete,true);assert.strictEqual(flow.calls.receiptDeliver,2);assert.strictEqual(flow.calls.payment,1);machine=result.machine;
 const done=await flow.executor.executeNext(machine,options);assert.strictEqual(done.action,null);assert.strictEqual(done.executed,false);assert.strictEqual(done.complete,true);assert.strictEqual(flow.calls.payment,1);

 const auditBlocked=harness();auditBlocked.flags.auditBeforeFailure=true;const blocked=await auditBlocked.executor.executeNext(approval(),options);assert.strictEqual(blocked.ok,false);assert.strictEqual(blocked.executed,false);assert.strictEqual(auditBlocked.calls.payment,0);assert.strictEqual(blocked.error.code,'AUDIT_DOWN');
 const afterWarning=harness();afterWarning.flags.auditAfterFailure=true;const after=await afterWarning.executor.executeNext(approval(),options);assert.strictEqual(after.ok,true);assert.strictEqual(after.executed,true);assert.strictEqual(after.machine.paymentId,'recPayment1');assert.match(after.auditWarning,/AUDIT_AFTER_DOWN/);assert.strictEqual(afterWarning.calls.payment,1);const afterNext=await afterWarning.executor.executeNext(after.machine,{mode:'simulate',env:stagingEnv()});assert.strictEqual(afterNext.action,'CREATE_RECEIPT_RECORD_ONCE');

 const provisionalReport=report({'Habilitación Provisional Aplicada':true,'MKJ Operation ID':'PROVISIONAL|abc'}),provisionalOwner=owner({'Reporte Habilitante Actual':['recReport1'],'Tipo de Habilitación':'Provisional por comprobante'});let rejection=state.authorizeRejection({report:provisionalReport,owner:provisionalOwner,adminId:'adminEnzo',reason:'Comprobante rechazado después de revisión',now:new Date('2026-07-13T20:00:00.000Z')});const reversalHarness=harness();reversalHarness.flags.relimitFailures=1;let reversal=await reversalHarness.executor.executeNext(rejection,options);assert.strictEqual(reversal.ok,false);assert.strictEqual(reversal.action,'RELIMIT_EXACT_REJECTED_REPORT');assert.strictEqual(reversal.machine.state,'REVERSAL_PENDING');assert.strictEqual(reversalHarness.calls.relimit,1);reversal=await reversalHarness.executor.executeNext(reversal.machine,options);assert.strictEqual(reversal.ok,true);assert.strictEqual(reversal.machine.state,'REVERSED');assert.strictEqual(reversalHarness.calls.relimit,2);assert.strictEqual(reversalHarness.calls.payment,0);assert.strictEqual((await reversalHarness.executor.executeNext(reversal.machine,options)).action,null);

 const source=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_payment_decision_executor.js'),'utf8');assert(!/airtableCreateRecord|airtablePatchRecord|syncOwnerAccess|mkjSetMemberStatus|sendMail|createAndSendReceipt/.test(source));assert(source.includes('PAYMENT_EXECUTION_PRODUCTION_BLOCKED'));
 console.log('PAYMENT_DECISION_EXECUTOR_OK');
})().catch(error=>{console.error(error);process.exit(1)});
