'use strict';

const { withAirtableUsage } = require('./_airtable_meter');

const { requireAdmin } = require('./_auth');
const { deepEscapeStrings, safeDisplayText } = require('./_security_utils');
const { calculateAllOwners, calculatedFields } = require('./_balance_engine_v4');
const { assertSafeAirtableContext, isolationResponse } = require('./_environment_guard');

let adminCache = null;
const ADMIN_CACHE_TTL_MS = 2 * 60 * 1000;
const AIRTABLE_TIMEOUT_MS = 9500;
const TABLES = { propietarios:'Propietarios', gastos:'Gastos del Mes', pagos:'Pagos', reportes:'Reportes de Pago' };
const FIELD_SETS = {
  propietarios: ['Propietario','Casa','Telefono','Email','Alicuota','Deuda Anterior','Deuda Anterior USD','Deuda Anterior Bs Ref','Deuda Restante','Total Pagado','Gasto del Mes','Cuota Base Mes','Recargo Aplicado','Monto a Pagar a Tiempo','MKJ User ID','MKJ Email','Estado Acceso Portón','Excepción Acceso','Última Sync MKJ','Motivo Limitación Acceso'],
  gastos: ['Concepto','Monto','Tipo de Gasto','Frecuencia','Propietarios','Forma de Pago'],
  pagos: ['Propietario que Paga','Monto Pagado','Fecha de Pago','Método de Pago','Forma de Pago','Monto Pagado Bs','Tasa BCV Aplicada','Equivalente USD Aplicado','[x] Aplicado al Cierre'],
  reportes: ['Reporte','Propietario que Reporta','Monto Reportado','Referencia','Fecha del Reporte','Estado','Forma de Pago Reportada','Monto Reportado Bs','Tasa BCV Reporte','Equivalente USD Reportado']
};
const NO_STORE_HEADERS = {'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate','Pragma':'no-cache','Expires':'0','Surrogate-Control':'no-store'};
function buildUrl(baseId, tableName, query){return 'https://api.airtable.com/v0/'+baseId+'/'+encodeURIComponent(tableName)+(query||'')}
function withFields(query, fields){const params=[];(fields||[]).forEach(name=>params.push('fields%5B%5D='+encodeURIComponent(name)));if(!params.length)return query||'';if(!query)return'?'+params.join('&');return query+(query.indexOf('?')===0&&query.length>1?'&':'?')+params.join('&')}
function getAirtableError(data,tableName){return data&&data.error&&data.error.message?data.error.message:(data&&data.message?data.message:'Error cargando '+tableName)}
async function fetchWithTimeout(url,options){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),AIRTABLE_TIMEOUT_MS);try{return await fetch(url,Object.assign({},options||{},{signal:controller.signal}))}finally{clearTimeout(timer)}}
async function airtableGetAll(tableName,query,token,baseId,counter){let records=[],offset=null,safeQuery=query||'';do{const separator=safeQuery?'&':'?';const url=buildUrl(baseId,tableName,safeQuery+(offset?separator+'offset='+encodeURIComponent(offset):''));counter.calls+=1;const response=await fetchWithTimeout(url,{headers:{Authorization:'Bearer '+token}});const data=await response.json();if(!response.ok)throw new Error(getAirtableError(data,tableName));records=records.concat(data.records||[]);offset=data.offset}while(offset);return records}
async function airtableGetAllWithFallback(tableName,preferredQuery,fallbackQuery,token,baseId,counter){try{return await airtableGetAll(tableName,preferredQuery,token,baseId,counter)}catch(error){console.warn('Fallo consulta preferida para '+tableName+'. Intentando fallback.',safeDisplayText(error.message,300));return airtableGetAll(tableName,fallbackQuery||'',token,baseId,counter)}}
async function safeLoad(label,loader,required){try{return{label,ok:true,records:(await loader())||[],error:null,required:!!required}}catch(error){return{label,ok:false,records:[],error:safeDisplayText(error.message,500),required:!!required}}}
function onlyPendingReports(records){return(records||[]).filter(record=>String(record?.fields?.Estado||'').trim().toLowerCase()==='pendiente')}
function flattenOwner(record,balance){return Object.assign({id:record.id},record.fields||{},calculatedFields(balance,record))}
const handler = async function(event){
  const auth=requireAdmin(event);if(!auth.ok)return auth.response;
  try{assertSafeAirtableContext({write:false,allowUnclassified:true});}catch(error){return isolationResponse(error);}
  const token=process.env.AIRTABLE_API_TOKEN,baseId=process.env.AIRTABLE_BASE_ID;
  if(!token||!baseId)return{statusCode:500,headers:NO_STORE_HEADERS,body:JSON.stringify({message:'Airtable no está configurado.'})};
  const force=(event.queryStringParameters||{}).force==='1';
  if(!force&&adminCache&&adminCache.expiresAt>Date.now())return{statusCode:200,headers:Object.assign({},NO_STORE_HEADERS,{'X-Cache':'HIT','X-Airtable-Calls':'0'}),body:JSON.stringify(adminCache.payload)};
  const counter={calls:0};
  try{
    const results=await Promise.all([
      safeLoad('propietarios',()=>airtableGetAll(TABLES.propietarios,withFields('',FIELD_SETS.propietarios),token,baseId,counter),true),
      safeLoad('gastos',()=>airtableGetAllWithFallback(TABLES.gastos,withFields('?view=Gastos%20Mensuales',FIELD_SETS.gastos),withFields('',FIELD_SETS.gastos),token,baseId,counter),true),
      safeLoad('pagos',()=>airtableGetAll(TABLES.pagos,withFields('',FIELD_SETS.pagos),token,baseId,counter),false),
      safeLoad('reportes',()=>airtableGetAllWithFallback(TABLES.reportes,withFields('?filterByFormula='+encodeURIComponent("{Estado}='Pendiente'"),FIELD_SETS.reportes),withFields('',FIELD_SETS.reportes),token,baseId,counter),false)
    ]);
    const byLabel=Object.fromEntries(results.map(r=>[r.label,r]));
    const requiredFailures=results.filter(r=>r.required&&!r.ok);
    if(requiredFailures.length&&adminCache?.payload){const stale=Object.assign({},adminCache.payload,{stale:true,warnings:requiredFailures.map(r=>({table:r.label,detail:r.error}))});return{statusCode:200,headers:Object.assign({},NO_STORE_HEADERS,{'X-Cache':'STALE','X-Airtable-Calls':String(counter.calls)}),body:JSON.stringify(stale)}}
    if(requiredFailures.length)return{statusCode:503,headers:Object.assign({},NO_STORE_HEADERS,{'X-Airtable-Calls':String(counter.calls)}),body:JSON.stringify({message:'Airtable tardó o falló cargando datos base.',detail:requiredFailures.map(r=>r.label+': '+r.error).join(' | ')})};
    const rawOwners=byLabel.propietarios.records||[],gastos=byLabel.gastos.records||[],pagos=byLabel.pagos.records||[];
    const balances=calculateAllOwners(rawOwners,gastos,pagos);
    const propietarios=rawOwners.map(record=>flattenOwner(record,balances.get(record.id))).sort((a,b)=>Number(a.Casa||0)-Number(b.Casa||0));
    const reportes=onlyPendingReports(byLabel.reportes.records||[]);
    const warnings=results.filter(r=>!r.ok).map(r=>({table:r.label,detail:r.error}));
    const payload=deepEscapeStrings({generatedAt:new Date().toISOString(),generatedAtCaracas:new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date()),balanceEngineVersion:4,propietarios,gastos,pagos,reportes,warnings,partial:warnings.length>0});
    adminCache={payload,expiresAt:Date.now()+ADMIN_CACHE_TTL_MS};
    return{statusCode:200,headers:Object.assign({},NO_STORE_HEADERS,{'X-Cache':force?'BYPASS':'MISS','X-Airtable-Calls':String(counter.calls)}),body:JSON.stringify(payload)};
  }catch(error){return{statusCode:500,headers:Object.assign({},NO_STORE_HEADERS,{'X-Airtable-Calls':String(counter.calls)}),body:JSON.stringify({message:'Error cargando datos administrativos.',detail:safeDisplayText(error.message,500)})}}
};

exports.handler = withAirtableUsage('admin-data-v2', handler);
