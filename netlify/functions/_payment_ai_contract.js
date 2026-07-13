'use strict';

const fs=require('fs');
const path=require('path');

const SCHEMA_PATH=path.join(__dirname,'..','..','config','payment-proof-analysis-v2.schema.json');
const DEFAULT_PROMPT_VERSION='VLA_PAYMENT_PROOF_V2_2026-07-13';
const METHODS=new Set(['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','OTHER','UNKNOWN']);
const CURRENCIES=new Set(['VES','USD','UNKNOWN']);
const STATUSES=new Set(['COMPLETED','SENT','PROCESSED','PENDING','SCHEDULED','FAILED','CANCELLED','REJECTED','UNKNOWN']);
const REQUIRED=['method','bank_or_platform','amount','currency','transaction_date','transaction_time','reference','transaction_status','recipient_name','recipient_phone','recipient_email','recipient_account_visible','memo','confidence','critical_fields_visible','warnings','possible_visual_modification'];
const ALLOWED=new Set(REQUIRED);
const TRANSIENT_FAILURES=new Set(['TIMEOUT','PROVIDER_UNAVAILABLE','RATE_LIMIT','TEMPORARY_ERROR','GENERATION_STUCK']);
const INVALID_OUTPUT_FAILURES=new Set(['INVALID_JSON','SCHEMA_INVALID','LOW_CONFIDENCE','CRITICAL_FIELDS_MISSING','EMPTY_OUTPUT']);

function clean(value){return String(value??'').trim()}
function nullableString(value,maxLength){if(value===null)return null;if(typeof value!=='string')throw new Error('Debe ser string o null.');const text=value.trim();if(text.length>maxLength)throw new Error(`Excede ${maxLength} caracteres.`);return text||null}
function normalizeDate(value){if(value===null)return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('La fecha debe usar YYYY-MM-DD o null.');const date=new Date(`${value}T00:00:00.000Z`);if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==value)throw new Error('La fecha no existe.');return value}
function normalizeTime(value){if(value===null)return null;if(typeof value!=='string'||!^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))throw new Error('La hora debe usar HH:mm:ss o null.');return value}
function parseRawJson(raw){if(typeof raw!=='string'||!raw.trim())return{ok:false,reason:'EMPTY_OUTPUT',raw:typeof raw==='string'?raw:''};try{return{ok:true,value:JSON.parse(raw),raw}}catch(error){return{ok:false,reason:'INVALID_JSON',raw,error:String(error.message||error)}}}
function validateAnalysis(value,{minimumConfidence=0}={}){
 const errors=[];
 if(!value||typeof value!=='object'||Array.isArray(value))return{ok:false,errors:['La salida debe ser un objeto JSON.']};
 const keys=Object.keys(value);for(const key of keys)if(!ALLOWED.has(key))errors.push(`Propiedad no permitida: ${key}.`);for(const key of REQUIRED)if(!Object.prototype.hasOwnProperty.call(value,key))errors.push(`Falta la propiedad ${key}.`);
 if(Object.prototype.hasOwnProperty.call(value,'approved'))errors.push('La IA no puede devolver approved.');
 if(!METHODS.has(value.method))errors.push('method no es válido.');if(!CURRENCIES.has(value.currency))errors.push('currency no es válida.');if(!STATUSES.has(value.transaction_status))errors.push('transaction_status no es válido.');
 if(value.amount!==null&&(typeof value.amount!=='number'||!Number.isFinite(value.amount)||value.amount<0))errors.push('amount debe ser número no negativo o null.');
 if(typeof value.confidence!=='number'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1)errors.push('confidence debe estar entre 0 y 1.');
 if(typeof value.critical_fields_visible!=='boolean')errors.push('critical_fields_visible debe ser boolean.');if(typeof value.possible_visual_modification!=='boolean')errors.push('possible_visual_modification debe ser boolean.');
 if(!Array.isArray(value.warnings)||value.warnings.length>30||value.warnings.some(item=>typeof item!=='string'||item.length>300))errors.push('warnings debe ser un arreglo de hasta 30 strings.');
 try{normalizeDate(value.transaction_date)}catch(error){errors.push(error.message)}try{normalizeTime(value.transaction_time)}catch(error){errors.push(error.message)}
 for(const[name,max]of Object.entries({bank_or_platform:160,reference:160,recipient_name:200,recipient_phone:80,recipient_email:254,recipient_account_visible:120,memo:500}))try{nullableString(value[name],max)}catch(error){errors.push(`${name}: ${error.message}`)}
 if(typeof value.confidence==='number'&&value.confidence<Number(minimumConfidence||0))errors.push('La confianza está por debajo del mínimo configurado.');
 return{ok:errors.length===0,errors};
}
function normalizeAnalysis(value){
 const normalized={method:value.method,bank_or_platform:nullableString(value.bank_or_platform,160),amount:value.amount===null?null:Number(value.amount),currency:value.currency,transaction_date:normalizeDate(value.transaction_date),transaction_time:normalizeTime(value.transaction_time),reference:nullableString(value.reference,160),transaction_status:value.transaction_status,recipient_name:nullableString(value.recipient_name,200),recipient_phone:nullableString(value.recipient_phone,80),recipient_email:nullableString(value.recipient_email,254),recipient_account_visible:nullableString(value.recipient_account_visible,120),memo:nullableString(value.memo,500),confidence:Number(value.confidence),critical_fields_visible:value.critical_fields_visible===true,warnings:value.warnings.map(item=>item.trim()).filter(Boolean),possible_visual_modification:value.possible_visual_modification===true};
 return normalized;
}
function evaluateRawOutput(raw,{minimumConfidence=0.85}={}){const parsed=parseRawJson(raw);if(!parsed.ok)return parsed;const validation=validateAnalysis(parsed.value,{minimumConfidence});if(!validation.ok){const reason=validation.errors.some(error=>error.includes('confianza'))?'LOW_CONFIDENCE':validation.errors.some(error=>error.includes('critical_fields_visible'))?'CRITICAL_FIELDS_MISSING':'SCHEMA_INVALID';return{ok:false,reason,raw,errors:validation.errors}}const normalized=normalizeAnalysis(parsed.value);if(!normalized.critical_fields_visible)return{ok:false,reason:'CRITICAL_FIELDS_MISSING',raw,normalized,errors:['Los campos críticos no están visibles.']};return{ok:true,raw,normalized}}
function safeConfig(config={}){return{aiEnabled:config.aiEnabled===true,primaryModel:clean(config.primaryModel),secondaryModel:clean(config.secondaryModel),primaryTimeoutSeconds:Math.max(10,Math.min(120,Number(config.primaryTimeoutSeconds)||45)),maximumPrimaryRetries:Math.max(0,Math.min(1,Math.trunc(Number(config.maximumPrimaryRetries)||0))),secondaryEnabled:config.secondaryEnabled===true,minimumConfidence:Math.max(0,Math.min(1,Number(config.minimumConfidence)||0.85)),externalFallbackEnabled:false,promptVersion:clean(config.promptVersion)||DEFAULT_PROMPT_VERSION}}
function nextAiAction({config,primaryAttempts=0,secondaryAttempts=0,lastFailure=''}){const settings=safeConfig(config),failure=clean(lastFailure).toUpperCase();if(!settings.aiEnabled||!settings.primaryModel)return{action:'MANUAL_URGENT',reason:'AI_NOT_CONFIGURED'};const maxPrimaryAttempts=1+settings.maximumPrimaryRetries;if(primaryAttempts<1)return{action:'PRIMARY',attempt:1};if(primaryAttempts<maxPrimaryAttempts&&TRANSIENT_FAILURES.has(failure))return{action:'PRIMARY_RETRY',attempt:primaryAttempts+1};if(settings.secondaryEnabled&&settings.secondaryModel&&secondaryAttempts<1&&(TRANSIENT_FAILURES.has(failure)||INVALID_OUTPUT_FAILURES.has(failure)))return{action:'SECONDARY',attempt:1};return{action:'MANUAL_URGENT',reason:failure||'AI_ATTEMPTS_EXHAUSTED'}}
function terminalProcessingState(result){if(result&&result.ok)return'Normalizando';return result&&['AI_NOT_CONFIGURED','AI_ATTEMPTS_EXHAUSTED','TIMEOUT','PROVIDER_UNAVAILABLE','RATE_LIMIT','TEMPORARY_ERROR','GENERATION_STUCK','INVALID_JSON','SCHEMA_INVALID','LOW_CONFIDENCE','CRITICAL_FIELDS_MISSING','EMPTY_OUTPUT'].includes(result.reason)?'Revisión manual urgente':'Requiere corrección'}
function analysisAudit({provider='',model='',promptVersion=DEFAULT_PROMPT_VERSION,startedAt,completedAt,attempt=1,secondary=false,result}={}){return{provider:clean(provider),model:clean(model),promptVersion:clean(promptVersion)||DEFAULT_PROMPT_VERSION,startedAt:startedAt?new Date(startedAt).toISOString():null,completedAt:completedAt?new Date(completedAt).toISOString():null,attempt:Number(attempt)||1,secondary:secondary===true,ok:result&&result.ok===true,failureReason:result&&result.ok?'':clean(result&&result.reason),rawPreserved:true}}
function schemaManifest(){return JSON.parse(fs.readFileSync(SCHEMA_PATH,'utf8'))}

module.exports={SCHEMA_PATH,DEFAULT_PROMPT_VERSION,METHODS,CURRENCIES,STATUSES,REQUIRED,ALLOWED,TRANSIENT_FAILURES,INVALID_OUTPUT_FAILURES,clean,nullableString,normalizeDate,normalizeTime,parseRawJson,validateAnalysis,normalizeAnalysis,evaluateRawOutput,safeConfig,nextAiAction,terminalProcessingState,analysisAudit,schemaManifest};
