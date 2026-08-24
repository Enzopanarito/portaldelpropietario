'use strict';

const contract=require('./_payment_ai_contract');
const {createGeminiAnalysisRunner}=require('./_payment_ai_gemini');

const DEFAULT_PROXY_URL=String(process.env.PAYMENT_PROOF_AI_PROXY_URL||'https://gemini-proxy-seinca.vercel.app/api/payment-proof').trim();
const PROXY_CLIENT='villa-los-apamates-payment-proof-v1';
const DEFAULT_PROXY_TIMEOUT_MS=20000;
const LEGACY_NULLABLE_FIELDS=Object.freeze([
 'recipient_account_last4',
 'recipient_document',
 'recipient_binance_id',
 'sender_name',
 'sender_account_visible'
]);
const FALLBACK_CODES=Object.freeze(new Set([
 'AI_AUTH_FAILED','AI_NOT_CONFIGURED','RATE_LIMIT','PROVIDER_UNAVAILABLE','AI_PROVIDER_ERROR',
 'AI_PROVIDER_UNAVAILABLE','AI_MODEL_INVALID','AI_MODEL_NOT_FOUND','TIMEOUT','AI_NETWORK_ERROR','EMPTY_OUTPUT'
]));

function clean(value){return String(value??'').trim()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}
function errorCode(error){return clean(error?.code).toUpperCase()}
function fallbackEligible(error){return FALLBACK_CODES.has(errorCode(error))}
function proxyError(payload,status){
 const sourceCode=clean(payload?.code).toUpperCase(),message=clean(payload?.message).slice(0,500);
 let code=sourceCode||'AI_PROVIDER_ERROR';
 if(status===401||status===403)code='AI_AUTH_FAILED';
 else if(status===408)code='TIMEOUT';
 else if(status===429)code='RATE_LIMIT';
 else if(status>=500)code='PROVIDER_UNAVAILABLE';
 else if(status===400&&!sourceCode)code='AI_PROVIDER_ERROR';
 return codedError(message||'El lector alterno no pudo procesar el comprobante.',code,{status,providerMessage:message});
}
function adaptProxyRaw(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)throw codedError('El lector alterno no devolvió JSON válido.','INVALID_OUTPUT',{detail:parsed.reason});
 let value=parsed.value;
 if(value?.analysis&&typeof value.analysis==='object'&&!Array.isArray(value.analysis))value=value.analysis;
 if(!value||typeof value!=='object'||Array.isArray(value))throw codedError('El lector alterno no devolvió un objeto utilizable.','INVALID_OUTPUT');
 const adapted={...value};
 for(const field of LEGACY_NULLABLE_FIELDS)if(!Object.prototype.hasOwnProperty.call(adapted,field))adapted[field]=null;
 const validation=contract.validateAnalysis(adapted,{minimumConfidence:0});
 const fatal=(validation.issueCodes||[]).filter(code=>!['CRITICAL_FIELDS_MISSING','LOW_CONFIDENCE'].includes(code));
 if(fatal.length)throw codedError('El lector alterno devolvió un esquema incompatible.','INVALID_OUTPUT',{detail:fatal[0],issues:validation.errors});
 return JSON.stringify(adapted);
}
async function analyzePaymentProofViaProxy({proof,promptVersion,fetchFn=global.fetch,proxyUrl=DEFAULT_PROXY_URL,timeoutMs=DEFAULT_PROXY_TIMEOUT_MS}={}){
 if(typeof fetchFn!=='function')throw codedError('El cliente HTTP del lector alterno no está disponible.','AI_PROVIDER_UNAVAILABLE');
 const url=clean(proxyUrl),content=Buffer.isBuffer(proof?.content)?proof.content:null,contentType=clean(proof?.contentType);
 if(!url)throw codedError('No existe un lector alterno configurado.','AI_NOT_CONFIGURED');
 if(!content||!content.length||!contentType)throw codedError('El comprobante no está disponible para análisis.','INVALID_ATTACHMENT');
 const controller=new AbortController(),configured=Math.max(5000,Math.min(60000,Number(timeoutMs)||DEFAULT_PROXY_TIMEOUT_MS)),timer=setTimeout(()=>controller.abort(),configured);
 try{
  const response=await fetchFn(url,{method:'POST',headers:{'Content-Type':'application/json','X-VLA-Client':PROXY_CLIENT},signal:controller.signal,body:JSON.stringify({content:content.toString('base64'),contentType,promptVersion})});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload?.ok!==true||!clean(payload?.raw))throw proxyError(payload,Number(response.status)||0);
  return{raw:adaptProxyRaw(payload.raw),model:`proxy:${clean(payload.model)||'gemini'}`,provider:'VLA AI Proxy',route:'proxy'};
 }catch(error){
  if(error?.name==='AbortError')throw codedError('El lector alterno excedió el tiempo máximo.','TIMEOUT',{status:504});
  throw error;
 }finally{clearTimeout(timer)}
}
function createPaymentProxyAnalysisRunner(options={}){
 return async function run({proof,promptVersion}={}){return analyzePaymentProofViaProxy({proof,promptVersion,...options})};
}
function createResilientPaymentAnalysisRunner({directRunner=createGeminiAnalysisRunner(),proxyRunner=createPaymentProxyAnalysisRunner()}={}){
 if(typeof directRunner!=='function'||typeof proxyRunner!=='function')throw codedError('Los proveedores de análisis no están disponibles.','AI_PROVIDER_UNAVAILABLE');
 return async function run(args={}){
  try{return await directRunner(args)}
  catch(error){if(!fallbackEligible(error))throw error;return proxyRunner(args)}
 };
}

module.exports={DEFAULT_PROXY_URL,PROXY_CLIENT,DEFAULT_PROXY_TIMEOUT_MS,LEGACY_NULLABLE_FIELDS,FALLBACK_CODES,clean,codedError,errorCode,fallbackEligible,proxyError,adaptProxyRaw,analyzePaymentProofViaProxy,createPaymentProxyAnalysisRunner,createResilientPaymentAnalysisRunner};
