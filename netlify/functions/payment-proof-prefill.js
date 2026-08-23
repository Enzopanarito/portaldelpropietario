'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {decodeAttachment}=require('./_shared/_payment_report_attachment');
const {createGeminiAnalysisRunner}=require('./_shared/_payment_ai_gemini');
const contract=require('./_shared/_payment_ai_contract');
const {consume}=require('./_shared/_persistent_rate_limit');
const {safeDisplayText}=require('./_shared/_security_utils');
const {mergeConfig}=require('./_shared/_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_shared/_payment_report_automation');
const {resolvePrefillDate}=require('./_shared/_payment_date_resolver');
const {signDateAttestation}=require('./_shared/_payment_date_attestation');
const {METHOD_ACCOUNT_MAP,accountActive,findAuthorizedRecipient}=require('./_shared/_payment_deterministic_arbiter');
const {signRecipientAttestation}=require('./_shared/_payment_recipient_attestation');

const WINDOW_MS=60*60*1000;
const FAST_PREFILL_MODEL='gemini-2.5-flash-lite';
const FALLBACK_PREFILL_MODEL='gemini-2.5-flash';
const CURRENT_STABLE_MODELS=Object.freeze([FALLBACK_PREFILL_MODEL,FAST_PREFILL_MODEL]);
const DIRECT_TIMEOUT_MS=8000;
const PROXY_TIMEOUT_MS=12000;
const PREFILL_TOTAL_BUDGET_MS=12000;
const TRANSIENT_RETRY_DELAY_MS=1000;
const MIN_DIRECT_WINDOW_MS=5000;
const MIN_PROXY_WINDOW_MS=1000;
const MAX_DIRECT_ATTEMPTS=4;
const PROXY_URL=String(process.env.PAYMENT_PROOF_AI_PROXY_URL||'').trim();
const PROXY_CLIENT='villa-los-apamates-payment-proof-v1';
const TRANSPORT_CODES=Object.freeze(new Set(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']));
const PUBLIC_FAILURE_CODES=Object.freeze(new Set(['PREFILL_CONFIG_UNAVAILABLE','AI_NETWORK_ERROR','PROVIDER_UNAVAILABLE','TIMEOUT','RATE_LIMIT','AI_AUTH_FAILED','AI_NOT_CONFIGURED','AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','EMPTY_OUTPUT','INVALID_OUTPUT','AI_PROVIDER_ERROR','AI_PROVIDER_UNAVAILABLE']));
const MODEL_FAILURE_CODES=Object.freeze(new Set(['AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','EMPTY_OUTPUT','INVALID_OUTPUT']));
const PROVIDER_FAILURE_CODES=Object.freeze(new Set(['PROVIDER_UNAVAILABLE','RATE_LIMIT','AI_AUTH_FAILED','AI_PROVIDER_ERROR']));

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite de prelectura no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
function methodLabel(method){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia bancaria internacional',BINANCE_PAY:'Binance Pay',CRYPTO_TRANSFER:'Binance / transferencia cripto',OTHER:'Otro método'}[method]||'')}
function requiredFieldsFor(){return['amount','currency','reference','method']}
function missingFields(analysis){
 const required=new Set(requiredFieldsFor(analysis?.method)),missing=[];
 if(required.has('amount')&&(!analysis||!Number(analysis.amount)))missing.push({field:'amount',label:'monto'});
 if(required.has('currency')&&(!analysis||!['VES','USD'].includes(analysis.currency)))missing.push({field:'currency',label:'moneda'});
 if(required.has('reference')&&!analysis?.reference)missing.push({field:'reference',label:'referencia'});
 if(required.has('method')&&!analysis?.bank_or_platform&&!methodLabel(analysis?.method))missing.push({field:'bank',label:'banco o método'});
 return missing;
}
async function loadAiConfig(){
 let records;
 try{records=await listAll(TABLES.config,'?maxRecords=1')}
 catch(_){throw Object.assign(new Error('La configuración de prelectura no está disponible.'),{code:'PREFILL_CONFIG_UNAVAILABLE'})}
 const record=records[0]||{fields:{}},rules=mergeConfig(record);
 return aiConfig(record,rules);
}
async function loadAuthorizedAccounts(){
 if(!TABLES.accounts)return{available:false,records:[]};
 try{return{available:true,records:await listAll(TABLES.accounts)}}
 catch(error){console.error(JSON.stringify({event:'VLA_PAYMENT_PREFILL_ACCOUNTS_UNAVAILABLE',code:String(error?.code||'AIRTABLE_READ_FAILED').slice(0,80)}));return{available:false,records:[]}}
}
function recipientVerification(analysis,accountState,config={},now=new Date()){
 const active=(accountState?.records||[]).filter(account=>accountActive(account,now));
 const minimumConfidence=Math.max(0,Math.min(1,Number(config.minimumConfidence??0.85)));
 if(accountState?.available!==true||!active.length||!METHOD_ACCOUNT_MAP[analysis?.method]||Number(analysis?.confidence||0)<minimumConfidence)return{classification:'INCONCLUSIVE',needsReview:true};
 const match=findAuthorizedRecipient(analysis,active,{now}),classification=String(match?.classification||'INCONCLUSIVE').toUpperCase();
 return{classification,needsReview:classification!=='CONFIRMED'};
}
function unique(values){return[...new Set((values||[]).map(value=>String(value||'').trim()).filter(Boolean))]}
function safeModelLabel(value){const model=String(value||'').trim();return/^[A-Za-z0-9._-]{3,120}$/.test(model)?model:'INVALID_MODEL'}
function modelCandidates(config={}){
 return unique([
  config.primaryModel,
  config.secondaryModel,
  FALLBACK_PREFILL_MODEL,
  FAST_PREFILL_MODEL
 ]).slice(0,10);
}
function errorCode(error){return String(error?.code||'').trim().toUpperCase()}
function transportCode(error){
 const candidates=[error?.transportCode,error?.cause?.code,error?.code].map(value=>String(value||'').trim().toUpperCase());
 for(const candidate of candidates)if(TRANSPORT_CODES.has(candidate))return candidate;
 return error?.name==='TypeError'&&/fetch failed/i.test(String(error?.message||''))?'FETCH_FAILED':'';
}
function normalizeTransportError(error){
 const code=errorCode(error);
 if(PUBLIC_FAILURE_CODES.has(code)||(code&&!TRANSPORT_CODES.has(code))||!transportCode(error))return error;
 return Object.assign(new Error('La conexión con el proveedor de análisis no está disponible temporalmente.'),{code:'AI_NETWORK_ERROR',transportCode:transportCode(error)});
}
function publicFailure(error){
 const code=errorCode(error),reason=PUBLIC_FAILURE_CODES.has(code)?code:'PREFILL_INTERNAL_ERROR',status=Number(error?.status||0);
 const failureClass=reason==='PREFILL_CONFIG_UNAVAILABLE'?'CONFIG':reason==='AI_NETWORK_ERROR'?'NETWORK':reason==='TIMEOUT'?'TIMEOUT':MODEL_FAILURE_CODES.has(reason)?'MODEL':PROVIDER_FAILURE_CODES.has(reason)?'PROVIDER':'RUNTIME';
 const providerResponse=failureClass==='PROVIDER'||(reason==='TIMEOUT'&&status===408);
 return{reason,failureClass,providerStatus:providerResponse&&Number.isInteger(status)&&status>=100&&status<=599?status:null};
}
function canTryAnotherModel(error){
 const status=Number(error?.status||0),code=errorCode(error);
 if(['INVALID_ATTACHMENT','AI_AUTH_FAILED','AI_NOT_CONFIGURED','RATE_LIMIT','PROVIDER_UNAVAILABLE','TIMEOUT'].includes(code))return false;
 if(['AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','EMPTY_OUTPUT','INVALID_OUTPUT'].includes(code))return true;
 return status===400||status===404;
}
function canRetryTransient(error){const status=Number(error?.status||0),code=errorCode(error);return code==='AI_NETWORK_ERROR'||status>=500&&status<600&&['PROVIDER_UNAVAILABLE','AI_PROVIDER_ERROR'].includes(code)}
function mustFailWithoutProxy(error){const code=errorCode(error);return['INVALID_ATTACHMENT','RATE_LIMIT','AI_NETWORK_ERROR','PROVIDER_UNAVAILABLE','TIMEOUT'].includes(code)||canRetryTransient(error)}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function budgetTimeout(){return Object.assign(new Error('La prelectura agotó su tiempo total protegido.'),{code:'TIMEOUT',status:504})}
function localGeminiConfigured(){return Boolean(String(process.env.GEMINI_API_KEY||'').trim())}
function validateRawForPrefill(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)throw Object.assign(new Error('La IA no devolvió JSON válido.'),{code:'INVALID_OUTPUT'});
 const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0});
 const fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
 if(fatal.length)throw Object.assign(new Error('La IA devolvió un esquema inválido.'),{code:'INVALID_OUTPUT',detail:fatal[0]});
 return String(raw).trim();
}
async function analyzeViaProxy({proof,promptVersion,fetchFn=global.fetch,proxyUrl=PROXY_URL,timeoutMs=PROXY_TIMEOUT_MS}={}){
 if(!proxyUrl)throw Object.assign(new Error('No existe un lector alterno configurado.'),{code:'AI_NOT_CONFIGURED'});
 const content=Buffer.isBuffer(proof?.content)?proof.content:null,contentType=String(proof?.contentType||'').trim();
 if(!content||!content.length||!contentType)throw Object.assign(new Error('El comprobante no está disponible para análisis.'),{code:'INVALID_ATTACHMENT'});
 const timeout=Math.max(1000,Math.min(PROXY_TIMEOUT_MS,Number(timeoutMs)||PROXY_TIMEOUT_MS)),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const response=await fetchFn(proxyUrl,{method:'POST',headers:{'Content-Type':'application/json','X-VLA-Client':PROXY_CLIENT},signal:controller.signal,body:JSON.stringify({content:content.toString('base64'),contentType,promptVersion})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload?.ok!==true||!String(payload?.raw||'').trim()){
   throw Object.assign(new Error(String(payload?.message||'El lector alterno no pudo procesar el comprobante.')),{code:String(payload?.code||'AI_PROVIDER_ERROR'),status:Number(response.status)||0});
  }
  return{raw:validateRawForPrefill(payload.raw),model:`proxy:${String(payload.model||'gemini').trim()}`,provider:'proxy'};
 }catch(error){
  if(error?.name==='AbortError')throw Object.assign(new Error('El análisis alterno excedió el tiempo máximo.'),{code:'TIMEOUT',status:504});
  throw normalizeTransportError(error);
 }finally{clearTimeout(timer)}
}
async function analyzeDirect({model,proof,report,promptVersion,runnerFactory=createGeminiAnalysisRunner,timeoutMs=DIRECT_TIMEOUT_MS}={}){
 const runner=runnerFactory({timeoutMs:Math.max(5000,Math.min(DIRECT_TIMEOUT_MS,Number(timeoutMs)||DIRECT_TIMEOUT_MS)),maxOutputTokens:2048});
 try{
  const raw=await runner({model,proof,report,promptVersion});
  return{raw:validateRawForPrefill(raw),model,provider:'direct'};
 }catch(error){throw normalizeTransportError(error)}
}
async function analyzeWithFallback({config,proof,report,promptVersion}={},deps={}){
 const direct=deps.analyzeDirect||analyzeDirect;
 const proxy=deps.analyzeViaProxy||analyzeViaProxy;
 const hasLocal=deps.localGeminiConfigured||localGeminiConfigured;
 const emitAttempt=deps.emitAttempt||((entry)=>console.info(JSON.stringify(entry)));
 const recordAttempt=entry=>{try{emitAttempt(entry)}catch(_){}};
 const now=deps.now||Date.now,sleep=deps.sleep||wait,budgetMs=Math.max(5000,Number(deps.budgetMs)||PREFILL_TOTAL_BUDGET_MS),startedAt=now();
 const remaining=()=>Math.max(0,budgetMs-(now()-startedAt));
 const directAttempt=model=>{const available=remaining();if(available<MIN_DIRECT_WINDOW_MS)throw budgetTimeout();return direct({model,proof,report,promptVersion,timeoutMs:Math.min(DIRECT_TIMEOUT_MS,available)})};
 const runDirectAttempt=async(model,index,phase='initial')=>{
  const attemptStartedAt=now();
  try{
   const result=await directAttempt(model);
   recordAttempt({event:'VLA_PAYMENT_PREFILL_ATTEMPT',route:'direct',model:safeModelLabel(model),attempt:index+1,phase,outcome:'SUCCESS',elapsedMs:Math.max(0,now()-attemptStartedAt)});
   return result;
  }catch(error){
   const failure=publicFailure(error);
   recordAttempt({event:'VLA_PAYMENT_PREFILL_ATTEMPT',route:'direct',model:safeModelLabel(model),attempt:index+1,phase,outcome:'FAILURE',elapsedMs:Math.max(0,now()-attemptStartedAt),reason:failure.reason,failureClass:failure.failureClass,providerStatus:failure.providerStatus});
   throw error;
  }
 };
 let lastError=null;

 if(hasLocal()){
  const models=modelCandidates(config).slice(0,MAX_DIRECT_ATTEMPTS);
  for(let index=0;index<models.length;index++){
   const model=models[index];
   try{return await runDirectAttempt(model,index)}
   catch(error){
    lastError=error;
    if(index===0&&canRetryTransient(error)&&remaining()>=TRANSIENT_RETRY_DELAY_MS+MIN_DIRECT_WINDOW_MS){
     await sleep(TRANSIENT_RETRY_DELAY_MS);
     try{return await runDirectAttempt(model,index,'retry')}catch(retryError){lastError=retryError}
    }
    if(mustFailWithoutProxy(lastError))throw lastError;
    if(!canTryAnotherModel(lastError))break;
   }
  }
 }

 const proxyBudget=remaining();
 if(proxyBudget<MIN_PROXY_WINDOW_MS)throw lastError||budgetTimeout();
 try{return await proxy({proof,promptVersion,timeoutMs:Math.min(PROXY_TIMEOUT_MS,proxyBudget)})}
 catch(error){
  if(!lastError||['AI_AUTH_FAILED','AI_NOT_CONFIGURED'].includes(errorCode(lastError)))lastError=error;
 }
 throw lastError||Object.assign(new Error('No hay un lector disponible para analizar el comprobante.'),{code:'AI_NOT_CONFIGURED'});
}

const handler=async event=>{
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 try{
  const body=JSON.parse(event.body||'{}'),ownerId=String(body.ownerId||'').trim();
  if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
  const attachment=decodeAttachment(body.attachment);
  if(!attachment)return json(400,{message:'Adjunte el comprobante antes de continuar.'});
  const [ipLimit,ownerLimit]=await Promise.all([allowed('PAYMENT_PREFILL_IP',clientIp(event),12),allowed('PAYMENT_PREFILL_OWNER',ownerId,8)]);
  if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{message:'Se alcanzó el límite temporal de lecturas. Puede completar los datos manualmente.',manualAvailable:true},{'Retry-After':String(retryAfter)})}
  const [config,accountState]=await Promise.all([loadAiConfig(),loadAuthorizedAccounts()]);
  if(!config.aiEnabled)return json(503,{message:'La lectura automática no está disponible. Complete los datos manualmente.',manualAvailable:true});
  const result=await analyzeWithFallback({config,proof:{content:attachment.content,contentType:attachment.contentType},report:{targetMode:''},promptVersion:config.promptVersion}),raw=result.raw;
  const parsed=contract.parseRawJson(raw);
  if(!parsed.ok)return json(422,{message:'No pudimos leer el comprobante con seguridad. Complete los datos manualmente.',manualAvailable:true,reason:parsed.reason});
  const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
  if(fatal.length)return json(422,{message:'El comprobante no devolvió datos utilizables. Complete los datos manualmente.',manualAvailable:true,reason:fatal[0]});
  const analysis=contract.normalizeAnalysis(parsed.value),missing=missingFields(analysis),bank=analysis.bank_or_platform||methodLabel(analysis.method),date=resolvePrefillDate({proofDate:analysis.transaction_date,attachment:body.attachment,method:analysis.method,bank}),attachmentSha=crypto.createHash('sha256').update(attachment.content).digest('hex'),recipient=recipientVerification(analysis,accountState,config);
  let dateAttestation='',recipientAttestation='';
  if(date.transactionDateSource==='PROOF_EXTRACTED'){
   try{dateAttestation=signDateAttestation({ownerId,attachmentSha,method:analysis.method,transactionDate:date.transactionDate,transactionDateEvidence:date.transactionDateEvidence})}
   catch(error){console.error(JSON.stringify({event:'VLA_PAYMENT_DATE_ATTESTATION_FAILED',ownerId,code:error.code||'DATE_ATTESTATION_ERROR'}))}
  }
  try{recipientAttestation=signRecipientAttestation({ownerId,attachmentSha,method:analysis.method,classification:recipient.classification})}
  catch(error){console.error(JSON.stringify({event:'VLA_PAYMENT_RECIPIENT_ATTESTATION_FAILED',ownerId,code:error.code||'RECIPIENT_ATTESTATION_ERROR'}))}
  return json(200,{success:true,complete:missing.length===0,analysis:{amount:analysis.amount,currency:analysis.currency,reference:analysis.reference||'',bank,method:analysis.method,...date,dateAttestation,recipientAttestation,recipientClassification:recipient.classification,recipientNeedsReview:recipient.needsReview,transactionTime:analysis.transaction_time||'',transactionStatus:analysis.transaction_status,recipient:analysis.recipient_name||analysis.recipient_phone||analysis.recipient_email||analysis.recipient_account_visible||'',confidence:analysis.confidence,warnings:analysis.warnings||[],possibleVisualModification:analysis.possible_visual_modification===true},missing,analysisProvider:result.model,analysisRoute:result.provider||'unknown'},{'X-Payment-AI-Provider':result.provider||'unknown'});
 }catch(error){
  const message=String(error?.message||'');
  if(['INVALID_ATTACHMENT'].includes(errorCode(error))||/adjunto|JPG|PNG|PDF|3 MB|formato/i.test(message))return json(400,{message:safeDisplayText(message,300),manualAvailable:false});
  const failure=publicFailure(error);
  const networkCode=failure.failureClass==='NETWORK'?transportCode(error):'';
  console.error(JSON.stringify({event:'VLA_PAYMENT_PREFILL_FAILED',...failure,...(networkCode?{transportCode:networkCode}:{})}));
  return json(503,{message:'La lectura inteligente no respondió. Intente nuevamente o complete los datos manualmente.',manualAvailable:true,...failure});
 }
};

exports.handler=withAirtableUsage('payment-proof-prefill',handler);
exports.missingFields=missingFields;
exports.requiredFieldsFor=requiredFieldsFor;
exports.methodLabel=methodLabel;
exports.unique=unique;
exports.safeModelLabel=safeModelLabel;
exports.modelCandidates=modelCandidates;
exports.errorCode=errorCode;
exports.transportCode=transportCode;
exports.normalizeTransportError=normalizeTransportError;
exports.publicFailure=publicFailure;
exports.canTryAnotherModel=canTryAnotherModel;
exports.canRetryTransient=canRetryTransient;
exports.mustFailWithoutProxy=mustFailWithoutProxy;
exports.validateRawForPrefill=validateRawForPrefill;
exports.analyzeViaProxy=analyzeViaProxy;
exports.analyzeDirect=analyzeDirect;
exports.analyzeWithFallback=analyzeWithFallback;
exports.loadAiConfig=loadAiConfig;
exports.loadAuthorizedAccounts=loadAuthorizedAccounts;
exports.recipientVerification=recipientVerification;
exports.FAST_PREFILL_MODEL=FAST_PREFILL_MODEL;
exports.PREFILL_TOTAL_BUDGET_MS=PREFILL_TOTAL_BUDGET_MS;
exports.CURRENT_STABLE_MODELS=CURRENT_STABLE_MODELS;
