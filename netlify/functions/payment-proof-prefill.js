'use strict';

const crypto=require('crypto');
const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {decodeAttachment}=require('./_shared/_payment_report_attachment');
const {createGeminiAnalysisRunner}=require('./_shared/_payment_ai_gemini');
const {discoverCompatibleModel}=require('./_shared/_payment_ai_model_discovery');
const {adaptProxyRaw}=require('./_shared/_payment_ai_proxy');
const contract=require('./_shared/_payment_ai_contract');
const {consume}=require('./_shared/_persistent_rate_limit');
const {safeDisplayText}=require('./_shared/_security_utils');
const {mergeConfig}=require('./_shared/_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_shared/_payment_report_automation');
const {resolvePrefillDate}=require('./_shared/_payment_date_resolver');
const {signDateAttestation}=require('./_shared/_payment_date_attestation');
const {METHOD_ACCOUNT_MAP,accountActive,findAuthorizedRecipient}=require('./_shared/_payment_deterministic_arbiter');
const {signRecipientAttestation}=require('./_shared/_payment_recipient_attestation');
const {currencyForMethod}=require('../../payment-report-intelligence');

const WINDOW_MS=60*60*1000;
const CURRENT_STABLE_MODELS=Object.freeze(['gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite','gemini-2.5-flash']);
const DIRECT_TIMEOUT_MS=9000;
const PROXY_TIMEOUT_MS=20000;
const MAX_DIRECT_ATTEMPTS=4;
const PREFILL_IP_SCOPE='PAYMENT_PREFILL_IP_V3';
const PREFILL_OWNER_SCOPE='PAYMENT_PREFILL_OWNER_V3';
const PROXY_URL=String(process.env.PAYMENT_PROOF_AI_PROXY_URL||'https://gemini-proxy-seinca.vercel.app/api/payment-proof').trim();
const PROXY_CLIENT='villa-los-apamates-payment-proof-v1';

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite de prelectura no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
function methodLabel(method){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia bancaria internacional',BINANCE_PAY:'Binance Pay',CRYPTO_TRANSFER:'Binance / transferencia cripto',OTHER:'Otro método'}[method]||'')}
function applyCurrencyPolicy(analysis){if(!analysis||typeof analysis!=='object')return analysis;return{...analysis,currency:currencyForMethod(analysis.method,analysis.currency)}}
function requiredFieldsFor(method){const normalized=String(method||'').trim().toUpperCase();return normalized==='ZELLE'?['amount','currency','method']:['amount','currency','reference','method']}
function missingFields(analysis){
 analysis=applyCurrencyPolicy(analysis);
 const required=new Set(requiredFieldsFor(analysis?.method)),missing=[];
 if(required.has('amount')&&(!analysis||!Number(analysis.amount)))missing.push({field:'amount',label:'monto'});
 if(required.has('currency')&&(!analysis||!['VES','USD'].includes(analysis.currency)))missing.push({field:'currency',label:'moneda'});
 if(required.has('reference')&&!analysis?.reference)missing.push({field:'reference',label:'referencia'});
 if(required.has('method')&&!analysis?.bank_or_platform&&!methodLabel(analysis?.method))missing.push({field:'bank',label:'banco o método'});
 return missing;
}
async function loadAiConfig(){const records=await listAll(TABLES.config,'?maxRecords=1'),record=records[0]||{fields:{}},rules=mergeConfig(record);return aiConfig(record,rules)}
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
function modelCandidates(config={},selection=null){
 return unique([
  selection?.model,
  ...(Array.isArray(selection?.models)?selection.models:[]),
  config.primaryModel,
  config.secondaryModel,
  ...CURRENT_STABLE_MODELS
 ]).slice(0,10);
}
function errorCode(error){return String(error?.code||'').trim().toUpperCase()}
function canTryAnotherModel(error){
 const status=Number(error?.status||0),code=errorCode(error);
 if(['INVALID_ATTACHMENT','AI_AUTH_FAILED','AI_NOT_CONFIGURED','RATE_LIMIT','PROVIDER_UNAVAILABLE','TIMEOUT'].includes(code))return false;
 if(['AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','EMPTY_OUTPUT','INVALID_OUTPUT'].includes(code))return true;
 return status===400||status===404;
}
function localGeminiConfigured(){return Boolean(String(process.env.GEMINI_API_KEY||'').trim())}
function validateRawForPrefill(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)throw Object.assign(new Error('La IA no devolvió JSON válido.'),{code:'INVALID_OUTPUT'});
 const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0});
 const fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
 if(fatal.length)throw Object.assign(new Error('La IA devolvió un esquema inválido.'),{code:'INVALID_OUTPUT',detail:fatal[0]});
 return String(raw).trim();
}
function prefillQuality(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)return{usable:false,complete:false,confidence:0,missing:[{field:'analysis',label:'lectura'}],rank:-1000};
 const analysis=applyCurrencyPolicy(contract.normalizeAnalysis(parsed.value)),missing=missingFields(analysis),confidence=Math.max(0,Math.min(1,Number(analysis.confidence)||0)),coreMissing=missing.filter(item=>['amount','currency','method'].includes(item.field)),usable=coreMissing.length===0&&confidence>=0.75,complete=missing.length===0;
 return{usable,complete,confidence,missing,analysis,rank:(usable?1000:0)+(complete?500:0)+confidence*100-missing.length*25};
}

async function analyzeViaProxy({proof,promptVersion,fetchFn=global.fetch,proxyUrl=PROXY_URL}={}){
 if(!proxyUrl)throw Object.assign(new Error('No existe un lector alterno configurado.'),{code:'AI_NOT_CONFIGURED'});
 const content=Buffer.isBuffer(proof?.content)?proof.content:null,contentType=String(proof?.contentType||'').trim();
 if(!content||!content.length||!contentType)throw Object.assign(new Error('El comprobante no está disponible para análisis.'),{code:'INVALID_ATTACHMENT'});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),PROXY_TIMEOUT_MS);
 try{
  const response=await fetchFn(proxyUrl,{method:'POST',headers:{'Content-Type':'application/json','X-VLA-Client':PROXY_CLIENT},signal:controller.signal,body:JSON.stringify({content:content.toString('base64'),contentType,promptVersion})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload?.ok!==true||!String(payload?.raw||'').trim()){
   throw Object.assign(new Error(String(payload?.message||'El lector alterno no pudo procesar el comprobante.')),{code:String(payload?.code||'AI_PROVIDER_ERROR'),status:Number(response.status)||0});
  }
  return{raw:validateRawForPrefill(adaptProxyRaw(payload.raw)),model:`proxy:${String(payload.model||'gemini').trim()}`,provider:'proxy'};
 }catch(error){
  if(error?.name==='AbortError')throw Object.assign(new Error('El análisis alterno excedió el tiempo máximo.'),{code:'TIMEOUT',status:504});
  throw error;
 }finally{clearTimeout(timer)}
}
async function analyzeDirect({model,proof,report,promptVersion,runnerFactory=createGeminiAnalysisRunner}={}){
 const runner=runnerFactory({timeoutMs:DIRECT_TIMEOUT_MS,maxOutputTokens:2048});
 const raw=await runner({model,proof,report,promptVersion});
 return{raw:validateRawForPrefill(raw),model,provider:'direct'};
}
async function analyzeWithFallback({config,proof,report,promptVersion}={},deps={}){
 const discover=deps.discoverCompatibleModel||discoverCompatibleModel;
 const direct=deps.analyzeDirect||analyzeDirect;
 const proxy=deps.analyzeViaProxy||analyzeViaProxy;
 const hasLocal=deps.localGeminiConfigured||localGeminiConfigured;
 const proxyFirst=deps.proxyFirst!==false;
 let selection=null,discoveryError=null,lastError=null,firstProxyError=null,bestResult=null,bestQuality=null;
 const consider=result=>{const quality=prefillQuality(result.raw);if(!bestQuality||quality.rank>bestQuality.rank){bestResult=result;bestQuality=quality}return quality};

 if(proxyFirst){
  try{const result=await proxy({proof,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result;lastError=Object.assign(new Error('La primera lectura quedó incompleta.'),{code:'LOW_QUALITY_OUTPUT',quality})}
  catch(error){firstProxyError=error;lastError=error;if(['INVALID_ATTACHMENT','RATE_LIMIT','TIMEOUT','PROVIDER_UNAVAILABLE'].includes(errorCode(error)))throw error}
 }

 if(hasLocal()){
  try{selection=await discover()}
  catch(error){discoveryError=error;lastError=error}
  const discoveryCode=errorCode(discoveryError),directAllowed=!['AI_AUTH_FAILED','AI_NOT_CONFIGURED'].includes(discoveryCode);
  if(directAllowed){
   const models=modelCandidates(config,selection).slice(0,MAX_DIRECT_ATTEMPTS);
   for(const model of models){
    try{const result=await direct({model,proof,report,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result;lastError=Object.assign(new Error('El modelo devolvió una lectura incompleta.'),{code:'LOW_QUALITY_OUTPUT',quality})}
    catch(error){lastError=error;if(!canTryAnotherModel(error))break}
   }
  }
 }

 if(!proxyFirst){
  try{const result=await proxy({proof,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result}
  catch(error){if(!lastError||['AI_AUTH_FAILED','AI_NOT_CONFIGURED'].includes(errorCode(lastError)))lastError=error}
 }
 if(bestResult)return bestResult;
 throw firstProxyError||lastError||Object.assign(new Error('No hay un lector disponible para analizar el comprobante.'),{code:'AI_NOT_CONFIGURED'});
}

const handler=async event=>{
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 try{
  const body=JSON.parse(event.body||'{}'),ownerId=String(body.ownerId||'').trim();
  if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
  const attachment=decodeAttachment(body.attachment);
  if(!attachment)return json(400,{message:'Adjunte el comprobante antes de continuar.'});
  const [ipLimit,ownerLimit]=await Promise.all([allowed(PREFILL_IP_SCOPE,clientIp(event),20),allowed(PREFILL_OWNER_SCOPE,ownerId,12)]);
  if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{message:'Se alcanzó el límite temporal de lecturas. Puede completar los datos manualmente.',manualAvailable:true},{'Retry-After':String(retryAfter)})}
  const accountStatePromise=loadAuthorizedAccounts();
  const config=await loadAiConfig();
  if(!config.aiEnabled)return json(503,{message:'La lectura automática no está disponible. Complete los datos manualmente.',manualAvailable:true});
  const result=await analyzeWithFallback({config,proof:{content:attachment.content,contentType:attachment.contentType},report:{targetMode:''},promptVersion:config.promptVersion}),raw=result.raw;
  const accountState=await accountStatePromise;
  const parsed=contract.parseRawJson(raw);
  if(!parsed.ok)return json(422,{message:'No pudimos leer el comprobante con seguridad. Complete los datos manualmente.',manualAvailable:true,reason:parsed.reason});
  const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
  if(fatal.length)return json(422,{message:'El comprobante no devolvió datos utilizables. Complete los datos manualmente.',manualAvailable:true,reason:fatal[0]});
  const analysis=applyCurrencyPolicy(contract.normalizeAnalysis(parsed.value)),missing=missingFields(analysis),bank=analysis.bank_or_platform||methodLabel(analysis.method),date=resolvePrefillDate({proofDate:analysis.transaction_date,attachment:body.attachment,method:analysis.method,bank}),attachmentSha=crypto.createHash('sha256').update(attachment.content).digest('hex'),recipient=recipientVerification(analysis,accountState,config);
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
  console.error('Prelectura de comprobante:',safeDisplayText(error?.code||message,300));
  return json(503,{message:'La lectura inteligente no respondió. Intente nuevamente o complete los datos manualmente.',manualAvailable:true,reason:safeDisplayText(error?.code||'AI_PROVIDER_ERROR',80),providerStatus:Number(error?.status)||null});
 }
};

exports.handler=withAirtableUsage('payment-proof-prefill',handler);
exports.missingFields=missingFields;
exports.requiredFieldsFor=requiredFieldsFor;
exports.methodLabel=methodLabel;
exports.unique=unique;
exports.modelCandidates=modelCandidates;
exports.errorCode=errorCode;
exports.canTryAnotherModel=canTryAnotherModel;
exports.validateRawForPrefill=validateRawForPrefill;
exports.analyzeViaProxy=analyzeViaProxy;
exports.analyzeDirect=analyzeDirect;
exports.analyzeWithFallback=analyzeWithFallback;
exports.prefillQuality=prefillQuality;
exports.applyCurrencyPolicy=applyCurrencyPolicy;
exports.loadAuthorizedAccounts=loadAuthorizedAccounts;
exports.recipientVerification=recipientVerification;
exports.CURRENT_STABLE_MODELS=CURRENT_STABLE_MODELS;
exports.PROXY_TIMEOUT_MS=PROXY_TIMEOUT_MS;
exports.PREFILL_IP_SCOPE=PREFILL_IP_SCOPE;
exports.PREFILL_OWNER_SCOPE=PREFILL_OWNER_SCOPE;
