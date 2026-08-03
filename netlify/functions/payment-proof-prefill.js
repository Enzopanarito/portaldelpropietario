'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {decodeAttachment}=require('./_payment_report_attachment');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');
const {getActiveModelSelection}=require('./_payment_ai_model_discovery');
const contract=require('./_payment_ai_contract');
const {consume}=require('./_persistent_rate_limit');
const {safeDisplayText}=require('./_security_utils');
const {mergeConfig}=require('./_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_payment_report_automation');

const WINDOW_MS=60*60*1000;
const ACCEPTED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);
const FAST_MODEL='gemini-3.5-flash-lite';
const FALLBACK_MODEL='gemini-3.6-flash';
const FAST_TIMEOUT_MS=8000;
const PROXY_TIMEOUT_MS=10000;
const PROXY_URL=String(process.env.PAYMENT_PROOF_AI_PROXY_URL||'https://gemini-proxy-seinca.vercel.app/api/payment-proof').trim();
const PROXY_CLIENT='villa-los-apamates-payment-proof-v1';

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite de prelectura no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
function methodLabel(method){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia bancaria internacional',BINANCE_PAY:'Binance Pay',CRYPTO_TRANSFER:'Binance / transferencia cripto',OTHER:'Otro método'}[method]||'')}
function missingFields(analysis){
 const missing=[];
 if(!analysis||!Number(analysis.amount))missing.push({field:'amount',label:'monto'});
 if(!analysis||!['VES','USD'].includes(analysis.currency))missing.push({field:'currency',label:'moneda'});
 if(!analysis?.reference)missing.push({field:'reference',label:'referencia'});
 if(!analysis?.bank_or_platform&&!methodLabel(analysis?.method))missing.push({field:'bank',label:'banco o método'});
 if(!analysis?.transaction_date)missing.push({field:'transactionDate',label:'fecha de la operación'});
 if(!analysis||!ACCEPTED_STATUSES.has(analysis.transaction_status))missing.push({field:'transactionStatus',label:'estado completado de la operación'});
 return missing;
}
async function loadAiConfig(){const records=await listAll(TABLES.config,'?maxRecords=1'),record=records[0]||{fields:{}},rules=mergeConfig(record);return aiConfig(record,rules)}
function unique(values){return[...new Set((values||[]).map(value=>String(value||'').trim()).filter(Boolean))]}
function modelCandidates(config={},selection=null){
 return unique([
  selection?.primaryModel,
  config.primaryModel,
  FAST_MODEL,
  selection?.secondaryModel,
  config.secondaryModel,
  FALLBACK_MODEL
 ]).slice(0,4);
}
function canTryAnotherModel(error){
 const status=Number(error?.status||0),code=String(error?.code||'');
 return['AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','RATE_LIMIT','PROVIDER_UNAVAILABLE','TIMEOUT','EMPTY_OUTPUT','AI_PROVIDER_ERROR','INVALID_OUTPUT','AI_AUTH_FAILED'].includes(code)&&(status!==400||code==='AI_MODEL_NOT_FOUND');
}
function localGeminiConfigured(){return Boolean(String(process.env.GEMINI_API_KEY||'').trim())}
function validateRawForPrefill(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)throw Object.assign(new Error('La IA no devolvió JSON válido.'),{code:'INVALID_OUTPUT'});
 const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
 if(fatal.length)throw Object.assign(new Error('La IA devolvió un esquema inválido.'),{code:'INVALID_OUTPUT',detail:fatal[0]});
 return String(raw).trim();
}
async function analyzeViaProxy({proof,promptVersion}={}){
 if(!PROXY_URL)throw Object.assign(new Error('No existe un lector alterno configurado.'),{code:'AI_NOT_CONFIGURED'});
 const content=Buffer.isBuffer(proof?.content)?proof.content:null,contentType=String(proof?.contentType||'').trim();
 if(!content||!content.length||!contentType)throw Object.assign(new Error('El comprobante no está disponible para análisis.'),{code:'INVALID_ATTACHMENT'});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),PROXY_TIMEOUT_MS);
 try{
  const response=await fetch(PROXY_URL,{method:'POST',headers:{'Content-Type':'application/json','X-VLA-Client':PROXY_CLIENT},signal:controller.signal,body:JSON.stringify({content:content.toString('base64'),contentType,promptVersion})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload?.ok!==true||!String(payload?.raw||'').trim()){
   throw Object.assign(new Error(String(payload?.message||'El lector alterno no pudo procesar el comprobante.')),{code:String(payload?.code||'AI_PROVIDER_ERROR'),status:Number(response.status)||0});
  }
  return{raw:validateRawForPrefill(payload.raw),model:`proxy:${String(payload.model||'gemini').trim()}`};
 }catch(error){
  if(error?.name==='AbortError')throw Object.assign(new Error('El análisis alterno excedió el tiempo máximo.'),{code:'TIMEOUT',status:504});
  throw error;
 }finally{clearTimeout(timer)}
}
async function analyzeDirect({model,proof,report,promptVersion}={}){
 const runner=createGeminiAnalysisRunner({timeoutMs:FAST_TIMEOUT_MS,maxOutputTokens:2048,thinkingLevel:'minimal'});
 const raw=await runner({model,proof,report,promptVersion});
 return{raw:validateRawForPrefill(raw),model};
}
function bestAggregateError(error,lastError){
 const errors=Array.isArray(error?.errors)?error.errors:[];
 return errors.find(item=>['AI_AUTH_FAILED','INVALID_ATTACHMENT'].includes(String(item?.code||'')))||errors[0]||lastError||error;
}
async function analyzeWithFallback({config,proof,report,promptVersion}={}){
 if(!localGeminiConfigured())return analyzeViaProxy({proof,promptVersion});
 const selection=await getActiveModelSelection().catch(()=>null),models=modelCandidates(config,selection),primary=models[0]||FAST_MODEL;
 let primaryError=null;
 try{return await analyzeDirect({model:primary,proof,report,promptVersion})}
 catch(error){primaryError=error;if(!canTryAnotherModel(error))throw error}
 const alternatives=models.filter(model=>model!==primary).slice(0,2).map(model=>analyzeDirect({model,proof,report,promptVersion}));
 if(PROXY_URL)alternatives.push(analyzeViaProxy({proof,promptVersion}));
 if(!alternatives.length)throw primaryError;
 try{return await Promise.any(alternatives)}
 catch(error){const selected=bestAggregateError(error,primaryError);selected.primaryProviderCode=String(primaryError?.code||'');throw selected}
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
  const config=await loadAiConfig();
  if(!config.aiEnabled)return json(503,{message:'La lectura automática no está disponible. Complete los datos manualmente.',manualAvailable:true});
  const result=await analyzeWithFallback({config,proof:{content:attachment.content,contentType:attachment.contentType},report:{targetMode:''},promptVersion:config.promptVersion}),raw=result.raw;
  const parsed=contract.parseRawJson(raw);
  if(!parsed.ok)return json(422,{message:'No pudimos leer el comprobante con seguridad. Complete los datos manualmente.',manualAvailable:true,reason:parsed.reason});
  const validation=contract.validateAnalysis(parsed.value,{minimumConfidence:0}),fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
  if(fatal.length)return json(422,{message:'El comprobante no devolvió datos utilizables. Complete los datos manualmente.',manualAvailable:true,reason:fatal[0]});
  const analysis=contract.normalizeAnalysis(parsed.value),missing=missingFields(analysis),bank=analysis.bank_or_platform||methodLabel(analysis.method);
  return json(200,{success:true,complete:missing.length===0,analysis:{amount:analysis.amount,currency:analysis.currency,reference:analysis.reference||'',bank,method:analysis.method,transactionDate:analysis.transaction_date||'',transactionTime:analysis.transaction_time||'',transactionStatus:analysis.transaction_status,recipient:analysis.recipient_name||analysis.recipient_phone||analysis.recipient_email||analysis.recipient_account_visible||'',confidence:analysis.confidence,warnings:analysis.warnings||[],possibleVisualModification:analysis.possible_visual_modification===true},missing,analysisProvider:result.model});
 }catch(error){
  const message=String(error?.message||'');
  if(['INVALID_ATTACHMENT'].includes(String(error?.code||''))||/adjunto|JPG|PNG|PDF|3 MB|formato/i.test(message))return json(400,{message:safeDisplayText(message,300),manualAvailable:false});
  console.error('Prelectura de comprobante:',safeDisplayText(error?.code||message,300));
  return json(503,{message:'La lectura inteligente no respondió. Intente nuevamente o complete los datos manualmente.',manualAvailable:true,reason:safeDisplayText(error?.code||'AI_PROVIDER_ERROR',80),providerStatus:Number(error?.status)||null});
 }
};

exports.handler=withAirtableUsage('payment-proof-prefill',handler);
exports.missingFields=missingFields;
exports.methodLabel=methodLabel;
exports.modelCandidates=modelCandidates;
exports.canTryAnotherModel=canTryAnotherModel;
exports.validateRawForPrefill=validateRawForPrefill;
exports.analyzeViaProxy=analyzeViaProxy;
exports.analyzeDirect=analyzeDirect;
exports.analyzeWithFallback=analyzeWithFallback;
