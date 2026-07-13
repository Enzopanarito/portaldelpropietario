'use strict';

const crypto=require('crypto');

function clean(value){return String(value??'').trim()}
function sha256(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function safeNoAction(result={}){return{...result,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,requiresAdminDecision:true}}
function failureResult(reason,detail='',extra={}){return safeNoAction({ok:false,processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reason:clean(reason)||'PROCESSING_FAILED',detail:clean(detail).slice(0,500),...extra})}
function defaults(){
 const proofCore=require('./_payment_proof_core');
 const proofStore=require('./_payment_proof_store');
 const processingStore=require('./_payment_processing_store');
 const duplicateCore=require('./_payment_duplicate_core');
 const snapshotCore=require('./_payment_access_snapshot');
 const aiContract=require('./_payment_ai_contract');
 const arbiter=require('./_payment_deterministic_arbiter');
 return{proofCore,proofStore,processingStore,duplicateCore,snapshotCore,aiContract,arbiter};
}
function aiFailureCode(error){const code=clean(error?.code).toUpperCase();if(code)return code;const message=clean(error?.message).toLowerCase();if(/timeout|timed out/.test(message))return'TIMEOUT';if(/rate|429/.test(message))return'RATE_LIMIT';if(/unavailable|503|502/.test(message))return'PROVIDER_UNAVAILABLE';return'TEMPORARY_ERROR'}
function duplicateInput(proof,analysis,fingerprint){return{exactSha:proof.sha256,visualHash:clean(analysis?.visualHash||analysis?.perceptualHash),fingerprint:clean(fingerprint),reference:analysis?.reference,bank_or_platform:analysis?.bank_or_platform,method:analysis?.method,currency:analysis?.currency,amount:analysis?.amount,transaction_date:analysis?.transaction_date,recipient_name:analysis?.recipient_name,recipient_phone:analysis?.recipient_phone,recipient_email:analysis?.recipient_email}}
function createOrchestrator(deps={}){
 const base=deps.modules||defaults(),proofCore=deps.proofCore||base.proofCore,duplicateCore=deps.duplicateCore||base.duplicateCore,snapshotCore=deps.snapshotCore||base.snapshotCore,aiContract=deps.aiContract||base.aiContract,arbiter=deps.arbiter||base.arbiter;
 const proofStore=deps.proofStore||base.proofStore.createProofStore(deps.proofStoreOptions||{}),processingStore=deps.processingStore||base.processingStore.createProcessingStore(deps.processingStoreOptions||{}),analysisRunner=deps.analysisRunner||null,now=deps.now||(()=>new Date());
 async function run(input={},env=process.env){
  const report=input.report||{},reportId=clean(report.id||input.reportId);if(!reportId)throw new Error('Falta reportId.');
  const config=aiContract.safeConfig(input.config||{}),promptVersion=config.promptVersion,proof=proofCore.decodeProofInput(input.attachment||{}),idempotencyKey=proofCore.buildIdempotencyKey(reportId,proof.sha256,promptVersion),payloadHash=sha256({reportId,attachmentSha:proof.sha256,promptVersion,targetMode:clean(report.targetMode||report.fields?.['Forma de Pago Reportada'])});
  let marker=null;
  try{
   const acquired=await processingStore.acquire({reportId,idempotencyKey,payloadHash},env);
   if(acquired.replay)return safeNoAction({...acquired.result,replayed:true});
   if(acquired.busy)return failureResult('PROCESSING_BUSY','El reporte ya está siendo procesado.',{processingState:'Recibido',retryAfterMs:acquired.retryAfterMs||0,busy:true});
   marker=acquired;
   await processingStore.update(marker,'Validando archivo',{attachmentSha:proof.sha256,promptVersion});
   const stored=await proofStore.put({reportId,content:proof.content,contentType:proof.contentType,attachmentSha:proof.sha256,variant:'original'},env);
   const duplicateData={reports:input.duplicateReports||[],payments:input.duplicatePayments||input.payments||[],history:input.duplicateHistory||[],excludeIds:[reportId]};
   const exactDuplicate=duplicateCore.findDuplicateMatches(duplicateInput(proof,null,''),duplicateData);
   if(exactDuplicate.isDuplicate){const decision=arbiter.evaluatePaymentReport({report,owner:input.owner,attachment:{valid:true,sha256:proof.sha256},analysis:null,snapshot:null,snapshotValidation:null,duplicate:exactDuplicate,authorizedAccounts:input.authorizedAccounts||[],config:{minimumConfidence:config.minimumConfidence},now:now()});const result=safeNoAction({ok:true,processingState:decision.processingState,resultValidation:decision.resultValidation,proof:{key:stored.key,sha256:proof.sha256,contentType:proof.contentType,size:proof.size},duplicate:exactDuplicate,analysis:null,snapshot:null,decision});await processingStore.complete(marker,result);return result}
   let analysisResult=null,rawPrimary='',rawSecondary='',aiAudit=[];
   if(!config.aiEnabled||!config.primaryModel||typeof analysisRunner!=='function')analysisResult={ok:false,reason:'AI_NOT_CONFIGURED',raw:''};
   else{
    let primaryAttempts=0,secondaryAttempts=0,lastFailure='';
    for(let guard=0;guard<4;guard+=1){
     const action=aiContract.nextAiAction({config,primaryAttempts,secondaryAttempts,lastFailure});
     if(action.action==='MANUAL_URGENT'){analysisResult={ok:false,reason:action.reason||lastFailure||'AI_ATTEMPTS_EXHAUSTED',raw:rawSecondary||rawPrimary};break}
     const secondary=action.action==='SECONDARY',model=secondary?config.secondaryModel:config.primaryModel,startedAt=now();
     if(secondary)secondaryAttempts+=1;else primaryAttempts+=1;
     await processingStore.update(marker,secondary?'Analizando IA secundaria':action.action==='PRIMARY_RETRY'?'Reintentando IA principal':'Analizando IA principal',{primaryAttempts,secondaryAttempts});
     try{
      const raw=await analysisRunner({role:secondary?'secondary':'primary',model,attempt:secondary?secondaryAttempts:primaryAttempts,proof:{filename:proof.filename,content:proof.content,contentType:proof.contentType,sha256:proof.sha256},report,owner:input.owner,promptVersion});
      if(secondary)rawSecondary=String(raw??'');else rawPrimary=String(raw??'');
      const evaluated=aiContract.evaluateRawOutput(String(raw??''),{minimumConfidence:config.minimumConfidence});
      aiAudit.push(aiContract.analysisAudit({provider:'Airtable AI',model,promptVersion,startedAt,completedAt:now(),attempt:secondary?secondaryAttempts:primaryAttempts,secondary,result:evaluated}));
      if(evaluated.ok){analysisResult=evaluated;break}
      lastFailure=evaluated.reason;analysisResult=evaluated;
     }catch(error){lastFailure=aiFailureCode(error);const failed={ok:false,reason:lastFailure,raw:''};aiAudit.push(aiContract.analysisAudit({provider:'Airtable AI',model,promptVersion,startedAt,completedAt:now(),attempt:secondary?secondaryAttempts:primaryAttempts,secondary,result:failed}));analysisResult=failed}
    }
   }
   const analysis=analysisResult&&analysisResult.ok?analysisResult.normalized:null;
   const fingerprint=analysis?duplicateCore.fingerprintHash(duplicateCore.canonicalFingerprint(analysis)):'';
   const duplicate=duplicateCore.findDuplicateMatches(duplicateInput(proof,analysis,fingerprint),duplicateData);
   let snapshot=null,snapshotValidation=null;
   if(input.owner){snapshot=snapshotCore.buildAccessSnapshot({owner:input.owner,expenses:input.expenses||[],payments:input.payments||[],officialRecords:input.officialRecords||[],bcvRate:input.bcvRate,bcvSource:input.bcvSource||'Configuración',now:now(),maxAgeMs:input.maxSnapshotAgeMs});snapshotValidation=snapshotCore.validateSnapshotStillCurrent(snapshot,{owner:input.owner,expenses:input.expenses||[],payments:input.payments||[],officialRecords:input.officialRecords||[],bcvRate:input.bcvRate,bcvSource:input.bcvSource||'Configuración',now:now(),maxAgeMs:input.maxSnapshotAgeMs})}
   const decision=arbiter.evaluatePaymentReport({report,owner:input.owner,attachment:{valid:proof.quality.acceptable!==false,sha256:proof.sha256},analysis,snapshot,snapshotValidation,duplicate,authorizedAccounts:input.authorizedAccounts||[],config:{minimumConfidence:config.minimumConfidence},now:now()});
   const result=safeNoAction({ok:true,processingState:decision.processingState,resultValidation:decision.resultValidation,proof:{key:stored.key,sha256:proof.sha256,contentType:proof.contentType,size:proof.size,quality:proof.quality},analysis:{ok:Boolean(analysis),normalized:analysis,rawPrimary,rawSecondary,audit:aiAudit,failureReason:analysisResult&&analysisResult.ok?'':clean(analysisResult?.reason)},financialFingerprint:fingerprint,duplicate,snapshot,decision});
   await processingStore.complete(marker,result);return result;
  }catch(error){const result=failureResult(error.code||'PROCESSING_FAILED',error.message,{proofSha:clean(input?.attachmentSha)});if(marker)await processingStore.fail(marker,error,{result}).catch(()=>null);return result}
 }
 return{run};
}

module.exports={clean,sha256,codedError,safeNoAction,failureResult,defaults,aiFailureCode,duplicateInput,createOrchestrator};
