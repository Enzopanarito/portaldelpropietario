'use strict';

require('./_airtable_usage_meter').install('batch-delete-records-v2');

const { requireAdmin } = require('./_auth');
const { ensureFinancialWritesAllowed } = require('./_financial_write_lock');

const ALLOWED_TABLES = new Set(['Gastos del Mes']);
const MAX_RECORDS_PER_REQUEST = 100;
const AIRTABLE_DELETE_BATCH_SIZE = 10;

function chunk(array,size){const chunks=[];for(let i=0;i<array.length;i+=size)chunks.push(array.slice(i,i+size));return chunks;}
function buildTableUrl(baseId,tableName){return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;}

exports.handler=async function(event){
  const auth=requireAdmin(event); if(!auth.ok)return auth.response;
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env; let airtableCalls=0;
  if(event.httpMethod!=='POST')return{statusCode:405,body:JSON.stringify({message:'Method Not Allowed'})};
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return{statusCode:500,body:JSON.stringify({message:'Airtable no está configurado.'})};
  try{
    const {tableName,recordIds}=JSON.parse(event.body||'{}');
    if(!ALLOWED_TABLES.has(tableName))return{statusCode:400,body:JSON.stringify({message:'Tabla no permitida para eliminación en lote.'})};
    const lock=await ensureFinancialWritesAllowed();if(!lock.ok)return lock.response;
    if(!Array.isArray(recordIds)||recordIds.length===0)return{statusCode:400,body:JSON.stringify({message:'Debe enviar al menos un registro para eliminar.'})};
    if(recordIds.length>MAX_RECORDS_PER_REQUEST)return{statusCode:400,body:JSON.stringify({message:`Máximo ${MAX_RECORDS_PER_REQUEST} registros por operación.`})};
    const cleanIds=[...new Set(recordIds.map(id=>String(id||'').trim()).filter(Boolean))];const deleted=[];
    for(const batch of chunk(cleanIds,AIRTABLE_DELETE_BATCH_SIZE)){const params=new URLSearchParams();batch.forEach(id=>params.append('records[]',id));const url=`${buildTableUrl(AIRTABLE_BASE_ID,tableName)}?${params.toString()}`;airtableCalls+=1;const response=await fetch(url,{method:'DELETE',headers:{Authorization:`Bearer ${AIRTABLE_API_TOKEN}`}});const data=await response.json();if(!response.ok)throw new Error(data.error?.message||'Error eliminando registros en Airtable.');deleted.push(...(data.records||[]));}
    return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Airtable-Calls':String(airtableCalls)},body:JSON.stringify({success:true,deletedCount:deleted.length,deleted})};
  }catch(error){return{statusCode:500,headers:{'Content-Type':'application/json','X-Airtable-Calls':String(airtableCalls)},body:JSON.stringify({message:'Error eliminando registros.',detail:error.message})};}
};
