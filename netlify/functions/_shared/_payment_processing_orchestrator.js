'use strict';

const crypto=require('crypto');

function clean(value){return String(value??'').trim()}
function sha256(value){return crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex')}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function safeNoAction(result={}){return{...result,automaticApproval:false,paymentAction:'NONE',accessAction:'NONE',canCreatePayment:false,canEnableAccess:false,requiresAdminDecision:true}}
function decisionActions(result={},decision={}){return{...result,automaticApproval:decision.automaticApproval===true,paymentAction:decision.paymentAction||'NONE',accessAction:decision.accessAction||'NONE',canCreatePayment:decision.canCreatePayment===true,canEnableAccess:false,requiresAdminDecision:decision.requiresAdminDecision!==false}}
function failureResult(reason,detail='',extra={}){return safeNoAction({ok:false,processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reason:clean(reason)||'PROCESSING_FAILED',detail:clean(detail).slice(0,500),...extra})}
function defaults(){
 const proofCore=require('./_payment_proof_core');
 const proofStore=require('./_payment_proof_store');
 const processingStore=require('./_payment_processing_store');
 const duplicateCore=require('./_payment_duplicate_core');
 const snapshotCore=require('./_payment_access_snapshot');
 const aiContract=require('./_payment_ai_contract');
 const arbiter=require('./_payment_deterministic_arbiter');
 const consensus=require('./_payment_ai_consensus');
 return{proofCore,proofStore,processingStore,duplicateCore,snapshotCore,aiContract,arbiter,consensus};
}
function aiFailureCode(error){const code=clean(error?.code).toUpperCase();if(code)return code;const message=clean(error?.message).toLowerCase();if(/timeout|timed out/.test(message))return'TIMEOUT';if(/rate|429/.test(message))return'RATE_LIMIT';if(/unavailable|503|502/.test(message))return'PROVIDER_UNAVAILABLE';return'TEMPORARY_ERROR'}
function duplicateInput(proof,analysis,fingerprint){return{exactSha:proof.sha256,visualHash:clean(proof?.visualHash||analysis?.visualHash||analysis?.perceptualHash),fingerprint:clean(fingerprint),reference:analysis?.reference,bank_or_platform:analysis?.bank_or_platform,method:analysis?.method,currency:analysis?.currency,amount:analysis?.amount,transaction_date:analysis?.transaction_date,recipient_name:analysis?.recipient_name,recipient_phone:analysis?.recipient_phone,recipient_email:analysis?.recipient_email,recipient:analysis?.recipient_binance_id||analysis?.recipient_account_last4}}
function retryDelayMs(attempt,random=Math.random){const base=Math.min(4000,400*Math.pow(2,Math.max(0,Number(attempt||1)-1))),jitter=Math.floor(Math.max(0,Math.min(1,Number(random())||0))*250);return base+jitter}
function createOrchestrator(deps={}){
 const base=deps.modules||defaults(),proofCore=deps.proofCore||base.proofCore,duplicateCore=deps.duplicateCore||base.duplicateCore,snapshotCore=deps.snapshotCore||base.snapshotCore,aiContract=deps.aiContract||base.aiContract,arbiter=deps.arbiter||base.arbiter,consensusCore=deps.consensusCore||base.consensus||require('./_payment_ai_consensus');
 const proofStore=deps.proofStore||base.proofStore.createProofStore(deps.proofStoreOptions||{}),processingStore=deps.processingStore||base.processingStore.createProcessingStore(deps.processingStoreOptions||{}),analysisRunner=deps.analysisRunner||null,now=deps.now||(()=>new Date()),sleep=deps.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))),random=deps.random||Math.random;
 async function run(input={},env=process.env){
  const report=input.report||{},reportId=clean(report.id||input.reportId);if(!reportId)throw new Error('Falta reportId.');
  const config=aiContract.safeConfig(input.config||{}),promptVersion=config.promptVersion,proof=proofCore.decodeProofInput(input.attachment||{});proof.visualHash=clean(input.attachment?.visualHash);proof.storedKey=clean(input.attachment?.storedKey);const idempotencyKey=proofCore.buildIdempotencyKey(reportId,proof.sha256,promptVersion),payloadHash=sha256({reportId,attachmentSha:proof.sha256,promptVersion,targetMode:clean(report.targetMode||report.fields?.['Forma de Pago Reportada'])});
  let marker=null,processingAttempts=0,failureAnalysis=null;
  try{
   const acquired=await processingStore.acquire({reportId,idempotencyKey,payloadHash},env);processingAttempts=Number(acquired?.record?.attempts||0);
   if(acquired.replay)return safeNoAction({...acquired.result,replayed:true});
   if(acquired.busy)return failureResult('PROCESSING_BUSY','El reporte ya está siendo procesado.',{processingState:'Recibido',retryAfterMs:acquired.retryAfterMs||0,busy:true,processingAttempts});
   marker=acquired;
   await processingStore.update(marker,'Validando archivo',{attachmentSha:proof.sha256,promptVersion});
   const stored=proof.storedKey?{key:proof.storedKey,sha256:proof.sha256,created:false,verifiedBeforeProcessing:true}:await proofStore.put({reportId,content:proof.content,contentType:proof.contentType,attachmentSha:proof.sha256,variant:'original'},env);
   const duplicateData={reports:input.duplicateReports||[],payments:input.duplicatePayments||input.payments||[],history:input.duplicateHistory||[],excludeIds:[reportId]};
   const exactDuplicate=duplicateCore.findDuplicateMatches(duplicateInput(proof,null,''),duplicateData);
   if(exactDuplicate.isDuplicate){const decision=arbiter.evaluatePaymentReport({report,owner:input.owner,attachment:{valid:true,sha256:proof.sha256},analysis:null,snapshot:null,snapshotValidation:null,duplicate:exactDuplicate,authorizedAccounts:input.authorizedAccounts||[],config:{minimumConfidence:config.minimumConfidence,automaticApprovalEnabled:false},now:now()});const result=safeNoAction({ok:true,processingState:decision.processingState,resultValidation:decision.resultValidation,proof:{key:stored.key,sha256:proof.sha256,visualHash:proof.visualHash,contentType:proof.contentType,size:proof.size},duplicate:exactDuplicate,analysis:null,snapshot:null,decision,processingAttempts});await processingStore.complete(marker,result);return result}
   let analysisResult=null,rawPrimary='',rawSecondary='',aiAudit=[],primarySuccessful=null,primaryFailureReason='',secondaryAttempts=0;
   if(!config.aiEnabled||!config.primaryModel||typeof analysisRunner!=='function')analysisResult={ok:false,reason:'AI_NOT_CONFIGURED',raw:''};
   else{
    let primaryAttempts=0,lastFailure='',primaryExtracted=null,dateRefinement=false;
    for(let guard=0;guard<4;guard+=1){
     const action=aiContract.nextAiAction({config,primaryAttempts,secondaryAttempts,lastFailure});
     if(action.action==='MANUAL_URGENT'){analysisResult={ok:false,reason:action.reason||lastFailure||'AI_ATTEMPTS_EXHAUSTED',raw:rawSecondary||rawPrimary};break}
     const secondary=action.action==='SECONDARY',model=secondary?config.secondaryModel:config.primaryModel,startedAt=now();
     if(secondary)secondaryAttempts+=1;else primaryAttempts+=1;
     if(action.action==='PRIMARY_RETRY')await sleep(retryDelayMs(primaryAttempts-1,random));
     await processingStore.update(marker,secondary?'Analizando IA secundaria':action.action==='PRIMARY_RETRY'?'Reintentando IA principal':'Analizando IA principal',{primaryAttempts,secondaryAttempts});
     try{
      const analysisReport=secondary&&dateRefinement?{...report,analysisFocus:'DATE_ONLY_SECOND_PASS'}:report;
      const raw=await analysisRunner({role:secondary?'secondary':'primary',model,attempt:secondary?secondaryAttempts:primaryAttempts,proof:{filename:proof.filename,content:proof.content,contentType:proof.contentType,sha256:proof.sha256},report:analysisReport,owner:input.owner,promptVersion,timeoutMs:config.primaryTimeoutSeconds*1000});
      if(secondary)rawSecondary=String(raw??'');else rawPrimary=String(raw??'');
      const evaluated=aiContract.evaluateRawOutput(String(raw??''),{minimumConfidence:config.minimumConfidence});
      aiAudit.push(aiContract.analysisAudit({provider:'Gemini API',model,promptVersion,startedAt,completedAt:now(),attempt:secondary?secondaryAttempts:primaryAttempts,secondary,result:evaluated}));
      const secondaryUsable=config.secondaryEnabled&&config.secondaryModel&&config.secondaryModel!==config.primaryModel;
      if(!secondary&&evaluated.ok){primarySuccessful=evaluated.normalized;analysisResult=evaluated;break}
      if(!secondary&&evaluated.normalized&&!evaluated.normalized.transaction_date&&secondaryUsable){primaryExtracted=evaluated.normalized;dateRefinement=true;lastFailure='CRITICAL_FIELDS_MISSING';primaryFailureReason=lastFailure;analysisResult=evaluated;continue}
      if(secondary&&dateRefinement&&primaryExtracted){
       if(evaluated.normalized){const merged={...primaryExtracted,transaction_date:evaluated.normalized.transaction_date||null,transaction_time:evaluated.normalized.transaction_time||primaryExtracted.transaction_time,warnings:[...new Set([...(primaryExtracted.warnings||[]),...(evaluated.normalized.warnings||[])])].slice(0,30)};merged.critical_fields_visible=Boolean(merged.amount&&merged.currency!=='UNKNOWN'&&merged.transaction_date&&merged.reference&&merged.transaction_status!=='UNKNOWN'&&(merged.recipient_name||merged.recipient_phone||merged.recipient_email||merged.recipient_account_visible||merged.recipient_binance_id));analysisResult={...aiContract.evaluateRawOutput(JSON.stringify(merged),{minimumConfidence:config.minimumConfidence}),dateSecondaryUsed:true};}else analysisResult={...analysisResult,normalized:primaryExtracted,dateSecondaryUsed:true};
       break;
      }
      if(evaluated.ok){analysisResult=evaluated;break}
      lastFailure=evaluated.reason;analysisResult=evaluated;if(!secondary)primaryFailureReason=lastFailure;
     }catch(error){lastFailure=aiFailureCode(error);if(!secondary)primaryFailureReason=lastFailure;const failed={ok:false,reason:lastFailure,raw:''};aiAudit.push(aiContract.analysisAudit({provider:'Gemini API',model,promptVersion,startedAt,completedAt:now(),attempt:secondary?secondaryAttempts:primaryAttempts,secondary,result:failed}));analysisResult=failed}
    }
   }

   failureAnalysis={ok:analysisResult?.ok===true,normalized:analysisResult?.normalized||null,rawPrimary,rawSecondary,audit:aiAudit,dateSecondaryUsed:analysisResult?.dateSecondaryUsed===true,failureReason:analysisResult&&analysisResult.ok?'':clean(analysisResult?.reason)};
   const finalAiReason=clean(analysisResult?.reason).toUpperCase();
   if(analysisResult?.ok!==true&&aiContract.TRANSIENT_FAILURES.has(finalAiReason))throw codedError('El análisis autenticado tuvo un fallo transitorio y será reintentado.',finalAiReason);
   if(config.automaticApprovalEnabled&&primarySuccessful===null&&aiContract.TRANSIENT_FAILURES.has(clean(primaryFailureReason).toUpperCase()))throw codedError('La lectura primaria necesaria para autopago tuvo un fallo transitorio.',clean(primaryFailureReason).toUpperCase());

   let aiConsensus={required:config.automaticApprovalEnabled===true,passed:false,reason:config.automaticApprovalEnabled?'PRIMARY_NOT_VERIFIED_FOR_AUTOPAY':'AUTOPAY_DISABLED',checks:[]};
   const secondaryUsable=config.secondaryEnabled&&config.secondaryModel&&config.secondaryModel!==config.primaryModel;
   if(config.automaticApprovalEnabled&&primarySuccessful){
    if(!secondaryUsable){aiConsensus={required:true,passed:false,reason:'SECONDARY_NOT_ENABLED',checks:[]}}
    else{
     const consensusStarted=now();secondaryAttempts+=1;
     await processingStore.update(marker,'Verificando consenso IA independiente',{secondaryAttempts,consensus:true});
     try{
      const raw=await analysisRunner({role:'secondary-consensus',model:config.secondaryModel,attempt:secondaryAttempts,proof:{filename:proof.filename,content:proof.content,contentType:proof.contentType,sha256:proof.sha256},report,owner:input.owner,promptVersion,timeoutMs:config.primaryTimeoutSeconds*1000});
      rawSecondary=String(raw??'');
      const evaluated=aiContract.evaluateRawOutput(rawSecondary,{minimumConfidence:config.minimumConfidence});
      aiAudit.push(aiContract.analysisAudit({provider:'Gemini API',model:config.secondaryModel,promptVersion,startedAt:consensusStarted,completedAt:now(),attempt:secondaryAttempts,secondary:true,result:evaluated}));
      if(evaluated.normalized){aiConsensus={...consensusCore.compareAnalyses(primarySuccessful,evaluated.normalized,config.minimumAutomaticConfidence),reason:evaluated.ok?'CONSENSUS_EVALUATED':clean(evaluated.reason||'SECONDARY_INVALID')}}
      else aiConsensus={required:true,passed:false,reason:clean(evaluated.reason||'SECONDARY_INVALID'),checks:[]};
      if(!evaluated.ok&&aiContract.TRANSIENT_FAILURES.has(clean(evaluated.reason).toUpperCase())){failureAnalysis={ok:true,normalized:primarySuccessful,rawPrimary,rawSecondary,audit:aiAudit,failureReason:clean(evaluated.reason)};throw codedError('La segunda lectura independiente tuvo un fallo transitorio.',clean(evaluated.reason).toUpperCase())}
     }catch(error){
      const code=aiFailureCode(error);if(!aiConsensus.reason||aiConsensus.reason==='CONSENSUS_EVALUATED')aiConsensus={required:true,passed:false,reason:code,checks:[]};
      failureAnalysis={ok:true,normalized:primarySuccessful,rawPrimary,rawSecondary,audit:aiAudit,failureReason:code};
      if(aiContract.TRANSIENT_FAILURES.has(code))throw codedError('La segunda lectura independiente tuvo un fallo transitorio.',code);
     }
    }
   }

   const analysis=analysisResult?.normalized||null;
   failureAnalysis={ok:analysisResult?.ok===true,normalized:analysis,rawPrimary,rawSecondary,audit:aiAudit,dateSecondaryUsed:analysisResult?.dateSecondaryUsed===true,failureReason:analysisResult&&analysisResult.ok?'':clean(analysisResult?.reason)};
   const fingerprint=analysis?duplicateCore.fingerprintHash(duplicateCore.canonicalFingerprint(analysis)):'';
   const duplicate=duplicateCore.findDuplicateMatches(duplicateInput(proof,analysis,fingerprint),duplicateData);
   let snapshot=null,snapshotValidation=null;
   if(input.owner){const dueDay=input.rules?.payment?.dueDay||10,surchargeRate=input.rules?.payment?.surchargeRate??0.10;snapshot=snapshotCore.buildAccessSnapshot({owner:input.owner,expenses:input.expenses||[],payments:input.payments||[],officialRecords:input.officialRecords||[],bcvRate:input.bcvRate,bcvSource:input.bcvSource||'Configuración',now:now(),maxAgeMs:input.maxSnapshotAgeMs,dueDay,surchargeRate});snapshotValidation=snapshotCore.validateSnapshotStillCurrent(snapshot,{owner:input.owner,expenses:input.expenses||[],payments:input.payments||[],officialRecords:input.officialRecords||[],bcvRate:input.bcvRate,bcvSource:input.bcvSource||'Configuración',now:now(),maxAgeMs:input.maxSnapshotAgeMs,dueDay,surchargeRate})}
   const decision=arbiter.evaluatePaymentReport({report,owner:input.owner,attachment:{valid:proof.quality.acceptable!==false,sha256:proof.sha256},analysis,snapshot,snapshotValidation,duplicate,authorizedAccounts:input.authorizedAccounts||[],config:{minimumConfidence:config.minimumConfidence,automaticApprovalEnabled:config.automaticApprovalEnabled&&aiConsensus.passed===true,minimumAutomaticConfidence:config.minimumAutomaticConfidence},now:now()});
   const consensusReason=config.automaticApprovalEnabled&&!aiConsensus.passed?`AI_CONSENSUS_${clean(aiConsensus.reason||'NOT_PASSED')}`:'';
   const enrichedDecision={...decision,aiConsensus,reasons:[...new Set([...(decision.reasons||[]),consensusReason].filter(Boolean))]};
   const result=decisionActions({ok:true,processingState:decision.processingState,resultValidation:decision.resultValidation,proof:{key:stored.key,sha256:proof.sha256,visualHash:proof.visualHash,contentType:proof.contentType,size:proof.size,quality:proof.quality},analysis:{ok:analysisResult?.ok===true,normalized:analysis,rawPrimary,rawSecondary,audit:aiAudit,dateSecondaryUsed:analysisResult?.dateSecondaryUsed===true,failureReason:analysisResult&&analysisResult.ok?'':clean(analysisResult?.reason)},financialFingerprint:fingerprint,duplicate,snapshot,decision:enrichedDecision,aiConsensus,processingAttempts},enrichedDecision);
   await processingStore.complete(marker,result);return result;
  }catch(error){const result=failureResult(error.code||'PROCESSING_FAILED',error.message,{proofSha:proof.sha256,processingAttempts,...(failureAnalysis?{analysis:failureAnalysis}:{})});if(marker)await processingStore.fail(marker,error,{result}).catch(()=>null);return result}
 }
 return{run};
}

module.exports={clean,sha256,codedError,safeNoAction,decisionActions,failureResult,defaults,aiFailureCode,duplicateInput,retryDelayMs,createOrchestrator};
