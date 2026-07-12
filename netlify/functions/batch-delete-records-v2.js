'use strict';

const { requireAdminCurrent } = require('./_auth');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');

const ALLOWED_TABLES = new Set(['Gastos del Mes']);
const MAX_RECORDS_PER_REQUEST = 100;
const AIRTABLE_DELETE_BATCH_SIZE = 10;
const USAGE_TABLE = 'ControlVersiones';

function chunk(array,size){const chunks=[];for(let i=0;i<array.length;i+=size)chunks.push(array.slice(i,i+size));return chunks;}
function currentMonthCaracas(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit'}).formatToParts(new Date());return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`;}
function buildTableUrl(baseId,tableName){return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;}
async function recordApiUsage(source,calls,token,baseId){if(!calls||calls<1)return;const key=`API_USAGE|${currentMonthCaracas()}|${source}|${Date.now()}|${Math.random().toString(36).slice(2,8)}`;try{await fetch(buildTableUrl(baseId,USAGE_TABLE),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({records:[{fields:{Key:key,Version:calls+1}}],typecast:true})});}catch(error){console.warn('No se pudo registrar contador API.',error.message);}}

exports.handler=async function(event){
  const auth=await requireAdminCurrent(event); if(!auth.ok)return auth.response;
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env; let airtableCalls=0;
  if(event.httpMethod!=='POST')return{statusCode:405,body:JSON.stringify({message:'Method Not Allowed'})};
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return{statusCode:500,body:JSON.stringify({message:'Airtable no está configurado.'})};
  try{
    const {tableName,recordIds}=JSON.parse(event.body||'{}');
    if(!ALLOWED_TABLES.has(tableName))return{statusCode:400,body:JSON.stringify({message:'Tabla no permitida para eliminación en lote.'})};
    const lock=await ensureFinancialWritesAllowed();if(!lock.ok)return lock.response;
    if(!Array.isArray(recordIds)||recordIds.length===0)return{statusCode:400,body:JSON.stringify({message:'Debe enviar al menos un registro para eliminar.'})};
    if(recordIds.length>MAX_RECORDS_PER_REQUEST)return{statusCode:400,body:JSON.stringify({message:`Máximo ${MAX_RECORDS_PER_REQUEST} registros por operación.`})};
    const cleanIds=[...new Set(recordIds.map(id=>String(id||'').trim()).filter(Boolean))];
    if(cleanIds.length!==recordIds.length||cleanIds.some(id=>!/^rec[A-Za-z0-9]{14}$/.test(id)))return{statusCode:400,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({message:'La lista contiene identificadores inválidos o duplicados.'})};
    const deleted=[];
    for(const batch of chunk(cleanIds,AIRTABLE_DELETE_BATCH_SIZE)){const params=new URLSearchParams();batch.forEach(id=>params.append('records[]',id));const url=`${buildTableUrl(AIRTABLE_BASE_ID,tableName)}?${params.toString()}`;airtableCalls+=1;const response=await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${AIRTABLE_API_TOKEN}`}});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Error eliminando registros en Airtable.');deleted.push(...(data.records||[]));}
    await recordApiUsage('batch-delete-records',airtableCalls,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID);
    return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Airtable-Calls':String(airtableCalls+1)},body:JSON.stringify({success:true,deletedCount:deleted.length,deleted})};
  }catch(error){await recordApiUsage('batch-delete-records-error',airtableCalls,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID);return{statusCode:500,headers:{'Content-Type':'application/json','X-Airtable-Calls':String(airtableCalls)},body:JSON.stringify({message:'Error eliminando registros.',detail:error.message})};}
};
