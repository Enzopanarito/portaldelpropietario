'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const { requireAdmin } = require('./_auth');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');
const { deepEscapeStrings, safeDisplayText } = require('./_security_utils');

const cache = new Map();
const CACHE_TTL_MS = { default:5*60*1000, propietarios:15*60*1000, gastos:15*60*1000, pagos:5*60*1000, reportes:30*1000 };
const ALLOWED_TABLES = new Set(['Propietarios','Gastos del Mes','Configuración','Pagos','Historial de Cargos','Reportes de Pago','Recibos de Pago','Cierres de Auditoría','WhatsApp Jobs','WhatsApp Programaciones']);
const GENERIC_WRITE_TABLES = new Set(['Propietarios','Configuración']);
const ALLOWED_METHODS = new Set(['GET','POST','PATCH','DELETE']);
const MAX_BODY_BYTES = 100000;

function normalizePath(path=''){return path.replace('/.netlify/functions/airtable','')||'/'}
function decodeSegments(path){return String(path||'').split('/').filter(Boolean).map(segment=>decodeURIComponent(segment))}
function parseTarget(path){const segments=decodeSegments(path),table=segments[0]||'',recordId=segments[1]||'';return{segments,table,recordId}}
function validRecordId(value){return !value||/^rec[A-Za-z0-9]{14}$/.test(value)}
function buildAirtableBaseUrl(baseId){return `https://api.airtable.com/v0/${baseId}`}
function buildAirtableUrl(event,airtablePath,baseId){const fallbackUrl=`https://local${event.path||''}${event.rawQuery?`?${event.rawQuery}`:''}`,currentUrl=new URL(event.rawUrl||fallbackUrl),params=new URLSearchParams(currentUrl.search);params.delete('force');params.delete('_');const qs=params.toString();return `${buildAirtableBaseUrl(baseId)}${airtablePath}${qs?`?${qs}`:''}`}
function getCacheTtl(path){const decoded=decodeURIComponent(path).toLowerCase();if(decoded.includes('propietarios'))return CACHE_TTL_MS.propietarios;if(decoded.includes('gastos del mes'))return CACHE_TTL_MS.gastos;if(decoded.includes('pagos')&&!decoded.includes('reportes'))return CACHE_TTL_MS.pagos;if(decoded.includes('reportes de pago'))return CACHE_TTL_MS.reportes;return CACHE_TTL_MS.default}
function getCacheKey(method,path,url){return `${method}:${path}:${url}`}
function shouldForceRefresh(event){const fallbackUrl=`https://local${event.path||''}${event.rawQuery?`?${event.rawQuery}`:''}`,currentUrl=new URL(event.rawUrl||fallbackUrl);return currentUrl.searchParams.get('force')==='1'}
function clearCache(){cache.clear()}
function isFinancialWrite(method,table){return method!=='GET'&&['Propietarios','Gastos del Mes','Pagos','Reportes de Pago'].includes(table)}
function reply(statusCode,body,extra={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra},body:JSON.stringify(body)}}

const handler = async function(event){
 const auth=requireAdmin(event);if(!auth.ok)return auth.response;
 const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env,{httpMethod,body}=event;
 if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return reply(500,{message:'Variables de entorno de Airtable no configuradas.'});
 if(!ALLOWED_METHODS.has(httpMethod))return reply(405,{message:'Método no permitido.'});
 if(Buffer.byteLength(String(body||''),'utf8')>MAX_BODY_BYTES)return reply(413,{message:'La solicitud es demasiado grande.'});
 const airtablePath=normalizePath(event.path),target=parseTarget(airtablePath);let airtableCalls=0;
 if(target.segments.length<1||target.segments.length>2||!ALLOWED_TABLES.has(target.table)||!validRecordId(target.recordId))return reply(400,{message:'Ruta de Airtable no permitida.'});
 if(httpMethod!=='GET'&&!GENERIC_WRITE_TABLES.has(target.table))return reply(403,{message:`Las escrituras directas en ${target.table} están bloqueadas. Use el flujo administrativo protegido correspondiente.`});
 try{
   if(isFinancialWrite(httpMethod,target.table)){const lock=await ensureFinancialWritesAllowed();if(!lock.ok)return lock.response;}
   const url=buildAirtableUrl(event,airtablePath,AIRTABLE_BASE_ID),forceRefresh=shouldForceRefresh(event),cacheKey=getCacheKey(httpMethod,airtablePath,url);
   if(httpMethod==='GET'&&!forceRefresh){const cached=cache.get(cacheKey);if(cached&&cached.expiresAt>Date.now())return reply(200,cached.data,{'X-Cache':'HIT','X-Airtable-Calls':'0','Cache-Control':'private, max-age=60'});}
   airtableCalls+=1;
   const response=await fetch(url,{method:httpMethod,headers:{Authorization:`Bearer ${AIRTABLE_API_TOKEN}`,'Content-Type':'application/json'},body:httpMethod!=='GET'?body:undefined});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)return reply(response.status,{message:data.error?.message||data.message||'Airtable rechazó la operación.'},{'X-Airtable-Calls':String(airtableCalls)});
   const safeData=deepEscapeStrings(data);
   if(httpMethod==='GET')cache.set(cacheKey,{data:safeData,expiresAt:Date.now()+getCacheTtl(airtablePath)});else clearCache();
   return reply(200,safeData,{'X-Cache':httpMethod==='GET'?'MISS':'BYPASS','X-Airtable-Calls':String(airtableCalls),'Cache-Control':httpMethod==='GET'?'private, max-age=60':'no-store'});
 }catch(error){return reply(503,{message:isFinancialWrite(httpMethod,target.table)?'No se pudo verificar el bloqueo financiero. La escritura fue detenida por seguridad.':'Error en la función del servidor.',detail:safeDisplayText(error.message,500)},{'X-Airtable-Calls':String(airtableCalls)});}
};

exports.handler = withAirtableUsage('airtable-v2', handler);
