'use strict';

const fs=require('fs');
const path=require('path');

const SCHEMA_PATH=path.join(__dirname,'..','..','config','payment-proof-analysis-v2.schema.json');
const DEFAULT_PROMPT_VERSION='VLA_PAYMENT_PROOF_V2_2026-07-13';
const DEFAULT_MAX_RAW_CHARS=100000;
const METHODS=new Set(['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','OTHER','UNKNOWN']);
const CURRENCIES=new Set(['VES','USD','UNKNOWN']);
const STATUSES=new Set(['COMPLETED','SENT','PROCESSED','PENDING','SCHEDULED','FAILED','CANCELLED','REJECTED','UNKNOWN']);
const REQUIRED=['method','bank_or_platform','amount','currency','transaction_date','transaction_time','reference','transaction_status','recipient_name','recipient_phone','recipient_email','recipient_account_visible','memo','confidence','critical_fields_visible','warnings','possible_visual_modification'];
const ALLOWED=new Set(REQUIRED);
const FORBIDDEN_DECISION_KEYS=new Set(['approved','approval','decision','payment_created','create_payment','access_enabled','provisional_access','gate_access','saldo_actualizado']);
const TRANSIENT_FAILURES=new Set(['TIMEOUT','PROVIDER_UNAVAILABLE','RATE_LIMIT','TEMPORARY_ERROR','GENERATION_STUCK']);
const INVALID_OUTPUT_FAILURES=new Set(['INVALID_JSON','SCHEMA_INVALID','FORBIDDEN_DECISION_OUTPUT','LOW_CONFIDENCE','CRITICAL_FIELDS_MISSING','EMPTY_OUTPUT','OUTPUT_TOO_LARGE']);

function clean(value){return String(value??'').trim()}
function boundedNumber(value,fallback,min,max){const number=Number(value);return Number.isFinite(number)?Math.min(max,Math.max(min,number)):fallback}
function nullableString(value,maxLength){if(value===null)return null;if(typeof value!=='string')throw new Error('Debe ser string o null.');const text=value.trim();if(text.length>maxLength)throw new Error(`Excede ${maxLength} caracteres.`);return text||null}
function normalizeDate(value){if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('La fecha debe usar YYYY-MM-DD o null.');const date=new Date(`${value}T00:00:00.000Z`);if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('La fecha no existe.');return value}
function normalizeTime(value){if(value===null)return null;if(typeof value!=='string'||!^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))throw new Error('La hora debe usar HH:mm:ss o null.');return value}
function parseRawJson(raw,{maxChars=DEFAULT_MAX_RAW_CHARS}={}){
 if(typeof raw!=='string'||!raw.trim())return{ok:false,reason:'EMPTY_OUTPUT',raw:typeof raw==='string'?raw:''};
 if(raw.length>Math.max(1000,Number(maxChars)||DEFAULT_MAX_RAW_CHARS))return{ok:false,reason:'OUTPUT_TOO_LARGE',raw:''};
 try{return{ok:true,value:JSON.parse(raw),raw}}catch(error){return{ok:false,reason:'INVALID_JSON',raw,error:String(error.message||error)}}
}
function validateAnalysis(value,{minimumConfidence=0}={}){
 const issues=[];const add=(code,message)=>issues.push({code,message});
 if(!value||typeof value!=='object'||Array.isArray(value))return{ok:false,issues:[{code:'SCHEMA_INVALID',message:'La salida debe ser un objeto JSON.'}],errors:['La salida debe ser un objeto JSON.'],issueCodes:['SCHEMA_INVALID']};
 const keys=Object.keys(value);
 for(const key of keys){if(FORBIDDEN_DECISION_KEYS.has(key))add('FORBIDDEN_DECISION_OUTPUT',`La IA no puede devolver ${key}.`);else if(!ALLOWED.has(key))add('SCHEMA_INVALID',`Propiedad no permitida: ${key}.`)}
 for(const key of REQUIRED)if(!Object.prototype.hasOwnProperty.call(value,key))add('SCHEMA_INVALID',`Falta la propiedad ${key}.`);
 if(!METHODS.has(value.method))add('SCHEMA_INVALID','method no es válido.');
 if(!CURRENCIES.has(value.currency))add('SCHEMA_INVALID','currency no es válida.');
 if(!STATUSES.has(value.transaction_status))add('SCHEMA_INVALID','transaction_status no es válido.');
 if(value.amount!==null&&(typeof value.amount!=='number'||!Number.isFinite(value.amount)||value.amount<0))add('SCHEMA_INVALID','amount debe ser número no negativo o null.');
 if(typeof value.confidence!=='number'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1)add('SCHEMA_INVALID','confidence debe estar entre 0 y 1.');
 if(typeof value.critical_fields_visible!=='boolean')add('SCHEMA_INVALID','critical_fields_visible debe ser boolean.');
 else if(value.critical_fields_visible!==true)add('CRITICAL_FIELDS_MISSING','Los campos críticos no están visibles.');
 if(typeof value.possible_visual_modification!=='boolean')add('SCHEMA_INVALID','possible_visual_modification debe ser boolean.');
 if(!Array.isArray(value.warnings)||value.warnings.length>30||value.warnings.some(item=>typeof item!=='string'||item.length>300))add('SCHEMA_INVALID','warnings debe ser un arreglo de hasta 30 strings.');
 try{normalizeDate(value.transaction_date)}catch(error){add('SCHEMA_INVALID',error.message)}
 try{normalizeTime(value.transaction_time)}catch(error){add('SCHEMA_INVALID',error.message)}
 for(const[name,max]of Object.entries({bank_or_platform:160,reference:160,recipient_name:200,recipient_phone:80,recipient_email:254,recipient_account_visible:120,memo:500}))try{nullableString(value[name],max)}catch(error){add('SCHEMA_INVALID',`${name}: ${error.message}`)}
 if(typeof value.confidence==='number'&&Number.isFinite(value.confidence)&&value.confidence<boundedNumber(minimumConfidence,0,0,1))add('LOW_CONFIDENCE','La confianza está por debajo del mínimo configurado.');
 return{ok:issues.length===0,issues,errors:issues.map(item=>item.message),issueCodes:[...new Set(issues.map(item=>item.code))]};
}
function normalizeAnalysis(value){return{method:value.method,bank_or_platform:nullableString(value.bank_or_platform,160),amount:value.amount===null?null:Number(value.amount),currency:value.currency,transaction_date:normalizeDate(value.transaction_date),transaction_time:normalizeTime(value.transaction_time),reference:nullableString(value.reference,160),transaction_status:value.transaction_status,recipient_name:nullableString(value.recipient_name,200),recipient_phone:nullableString(value.recipient_phone,80),recipient_email:nullableString(value.recipient_email,254),recipient_account_visible:nullableString(value.recipient_account_visible,120),memo:nullableString(value.memo,500),confidence:Number(value.confidence),critical_fields_visible:value.critical_fields_visible===true,warnings:value.warnings.map(item=>item.trim()).filter(Boolean),possible_visual_modification:value.possible_visual_modification===true}}
function failureReason(validation){const codes=new Set(validation.issueCodes||[]);if(codes.has('FORBIDDEN_DECISION_OUTPUT'))return'FORBIDDEN_DECISION_OUTPUT';if(codes.has('SCHEMA_INVALID'))return'SCHEMA_INVALID';if(codes.has('CRITICAL_FIELDS_MISSING'))return'CRITICAL_FIELDS_MISSING';if(codes.has('LOW_CONFIDENCE'))return'LOW_CONFIDENCE';return'SCHEMA_INVALID'}
function evaluateRawOutput(raw,{minimumConfidence=0.85,maxChars=DEFAULT_MAX_RAW_CHARS}={}){const parsed=parseRawJson(raw,{maxChars});if(!parsed.ok)return parsed;const validation=validateAnalysis(parsed.value,{minimumConfidence});if(!validation.ok)return{ok:false,reason:failureReason(validation),raw,errors:validation.errors,issueCodes:validation.issueCodes};return{ok:true,raw,normalized:normalizeAnalysis(parsed.value)}}
function safeConfig(config={}){return{aiEnabled:config.aiEnabled===true,primaryModel:clean(config.primaryModel),secondaryModel:clean(config.secondaryModel),primaryTimeoutSeconds:Math.round(boundedNumber(config.primaryTimeoutSeconds,45,10,120)),maximumPrimaryRetries:Math.trunc(boundedNumber(config.maximumPrimaryRetries,0,0,1)),secondaryEnabled:config.secondaryEnabled===true,minimumConfidence:boundedNumber(config.minimumConfidence,0.85,0,1),externalFallbackEnabled:false,promptVersion:clean(config.promptVersion)||DEFAULT_PROMPT_VERSION}}
function nextAiAction({config,primaryAttempts=0,secondaryAttempts=0,lastFailure=''}={}){
 const settings=safeConfig(config),failure=clean(lastFailure).toUpperCase();
 if(!settings.aiEnabled||!settings.primaryModel)return{action:'MANUAL_URGENT',reason:'AI_NOT_CONFIGURED'};
 const attemptedPrimary=Math.max(0,Math.trunc(Number(primaryAttempts)||0)),attemptedSecondary=Math.max(0,Math.trunc(Number(secondaryAttempts)||0)),maxPrimaryAttempts=1+settings.maximumPrimaryRetries;
 if(attemptedPrimary<1)return{action:'PRIMARY',attempt:1};
 if(attemptedPrimary<maxPrimaryAttempts&&TRANSIENT_FAILURES.has(failure))return{action:'PRIMARY_RETRY',attempt:attemptedPrimary+1};
 const secondaryUsable=settings.secondaryEnabled&&settings.secondaryModel&&settings.secondaryModel!==settings.primaryModel;
 if(secondaryUsable&&attemptedSecondary<1&&(TRANSIENT_FAILURES.has(failure)||INVALID_OUTPUT_FAILURES.has(failure)))return{action:'SECONDARY',attempt:1};
 return{action:'MANUAL_URGENT',reason:failure||'AI_ATTEMPTS_EXHAUSTED'};
}
function terminalProcessingState(result){if(result&&result.ok)return'Normalizando';const reason=clean(result&&result.reason).toUpperCase();return['AI_NOT_CONFIGURED','AI_ATTEMPTS_EXHAUSTED',...TRANSIENT_FAILURES,...INVALID_OUTPUT_FAILURES].includes(reason)?'Revisión manual urgente':'Requiere corrección'}
function isoOrNull(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null}
function analysisAudit({provider='',model='',promptVersion=DEFAULT_PROMPT_VERSION,startedAt,completedAt,attempt=1,secondary=false,result}={}){return{provider:clean(provider),model:clean(model),promptVersion:clean(promptVersion)||DEFAULT_PROMPT_VERSION,startedAt:isoOrNull(startedAt),completedAt:isoOrNull(completedAt),attempt:Math.max(1,Math.trunc(Number(attempt)||1)),secondary:secondary===true,ok:result&&result.ok===true,failureReason:result&&result.ok?'':clean(result&&result.reason),rawPreserved:typeof result?.raw==='string'}}
function schemaManifest(){return JSON.parse(fs.readFileSync(SCHEMA_PATH,'utf8'))}

module.exports={SCHEMA_PATH,DEFAULT_PROMPT_VERSION,DEFAULT_MAX_RAW_CHARS,METHODS,CURRENCIES,STATUSES,REQUIRED,ALLOWED,FORBIDDEN_DECISION_KEYS,TRANSIENT_FAILURES,INVALID_OUTPUT_FAILURES,clean,boundedNumber,nullableString,normalizeDate,normalizeTime,parseRawJson,validateAnalysis,normalizeAnalysis,failureReason,evaluateRawOutput,safeConfig,nextAiAction,terminalProcessingState,isoOrNull,analysisAudit,schemaManifest};
