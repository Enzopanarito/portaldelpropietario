'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {decodeAttachment}=require('./_payment_report_attachment');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');
const contract=require('./_payment_ai_contract');
const {consume}=require('./_persistent_rate_limit');
const {safeDisplayText}=require('./_security_utils');
const {mergeConfig}=require('./_automation_rules');
const {listAll,TABLES,aiConfig}=require('./_payment_report_automation');

const WINDOW_MS=60*60*1000;
const ACCEPTED_STATUSES=new Set(['COMPLETED','SENT','PROCESSED']);
const FAST_MODEL='gemini-2.5-flash-lite';
const FALLBACK_MODEL='gemini-2.5-flash';
const FAST_TIMEOUT_MS=15000;

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function clientIp(event){const headers=event.headers||{};return String(headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||headers['x-forwarded-for']||headers['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(scope,identity,max){try{return await consume({scope,identity,max,windowMs:WINDOW_MS,countBeforeRecord:true})}catch(error){console.warn('Límite de prelectura no disponible:',error.message);return{allowed:true,retryAfter:3600}}}
function methodLabel(method){return({TRANSFER_VE:'Transferencia bancaria',MOBILE_PAYMENT_VE:'Pago móvil',ZELLE:'Zelle',TRANSFER_US:'Transferencia bancaria internacional',OTHER:'Otro método'}[method]||'')}
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
function modelCandidates(config={}){return[FAST_MODEL,config.primaryModel,config.secondaryModel,FALLBACK_MODEL].map(value=>String(value||'').trim()).filter((value,index,array)=>value&&array.indexOf(value)===index)}
function canTryAnotherModel(error){const status=Number(error?.status||0);return['AI_MODEL_INVALID','RATE_LIMIT','PROVIDER_UNAVAILABLE','TIMEOUT','EMPTY_OUTPUT','AI_PROVIDER_ERROR'].includes(String(error?.code||''))&&(status!==401&&status!==403)}
async function analyzeWithFallback({config,proof,report,promptVersion}={}){
 const runner=createGeminiAnalysisRunner({timeoutMs:FAST_TIMEOUT_MS}),models=modelCandidates(config);let lastError=null;
 for(let index=0;index<models.length;index++)try{return{raw:await runner({model:models[index],proof,report,promptVersion}),model:models[index]}}catch(error){lastError=error;if(index===models.length-1||!canTryAnotherModel(error))break}
 throw lastError||Object.assign(new Error('No hay un modelo disponible para analizar el comprobante.'),{code:'AI_NOT_CONFIGURED'});
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
  return json(200,{success:true,complete:missing.length===0,analysis:{amount:analysis.amount,currency:analysis.currency,reference:analysis.reference||'',bank,method:analysis.method,transactionDate:analysis.transaction_date||'',transactionTime:analysis.transaction_time||'',transactionStatus:analysis.transaction_status,recipient:analysis.recipient_name||analysis.recipient_phone||analysis.recipient_email||analysis.recipient_account_visible||'',confidence:analysis.confidence,warnings:analysis.warnings||[],possibleVisualModification:analysis.possible_visual_modification===true},missing});
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
exports.analyzeWithFallback=analyzeWithFallback;
