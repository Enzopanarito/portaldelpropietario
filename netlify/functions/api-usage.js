// netlify/functions/api-usage.js
// Lee el contador mensual de llamadas a Airtable registradas por las funciones del portal.

const { requireAdmin } = require('./_auth');
const TABLE = 'ControlVersiones';

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate'
};

function currentMonthCaracas(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit'}).formatToParts(new Date());
  return `${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`;
}
function buildUrl(baseId,tableName,query=''){
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}
async function airtableGetAll(tableName,query,token,baseId){
  let records=[];let offset=null;const safeQuery=query||'';
  do{
    const separator=safeQuery?'&':'?';
    const url=buildUrl(baseId,tableName,`${safeQuery}${offset?`${separator}offset=${encodeURIComponent(offset)}`:''}`);
    const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||`Error cargando ${tableName}`);
    records=records.concat(data.records||[]);
    offset=data.offset;
  }while(offset);
  return records;
}
function parseUsageKey(key){
  const parts=String(key||'').split('|');
  if(parts[0]!=='API_USAGE')return null;
  return{month:parts[1]||'',source:parts[2]||'desconocido',timestamp:parts[3]||''};
}
function emptyPayload(month,note,detail){
  const limit=1000;
  return {month,total:0,limit,percent:0,remaining:limit,events:0,bySource:{},lastEvent:null,note,detail:detail||null};
}
exports.handler=async function(event){
  const auth=requireAdmin(event); if(!auth.ok)return auth.response;
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID){
    return{statusCode:200,headers:HEADERS,body:JSON.stringify(emptyPayload(currentMonthCaracas(),'Airtable no está configurado para contador API.'))};
  }
  const month=(event.queryStringParameters&&event.queryStringParameters.month)||currentMonthCaracas();
  try{
    const formula=`IFERROR(FIND('API_USAGE|${month}|', {Key}), 0)`;
    let records=[];
    try{
      records=await airtableGetAll(TABLE,`?filterByFormula=${encodeURIComponent(formula)}`,AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID);
    }catch(preferredError){
      console.warn('Filtro del contador falló, usando lectura completa.', preferredError.message);
      try{
        const all=await airtableGetAll(TABLE,'',AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID);
        records=all.filter(r=>String(r.fields?.Key||'').includes(`API_USAGE|${month}|`));
      }catch(fallbackError){
        return{statusCode:200,headers:HEADERS,body:JSON.stringify(emptyPayload(month,'No se pudo leer ControlVersiones, pero el admin puede seguir funcionando.',fallbackError.message))};
      }
    }
    const bySource={};let total=0,lastEvent=null;
    records.forEach(record=>{
      const key=record.fields?.Key||'';
      const parsed=parseUsageKey(key);
      if(!parsed)return;
      const calls=Number(record.fields?.Version||0);
      total+=calls;
      bySource[parsed.source]=(bySource[parsed.source]||0)+calls;
      if(!lastEvent||String(parsed.timestamp)>String(lastEvent))lastEvent=parsed.timestamp;
    });
    const limit=1000;
    const percent=Math.min(100,Math.round((total/limit)*100));
    return{statusCode:200,headers:HEADERS,body:JSON.stringify({month,total,limit,percent,remaining:Math.max(0,limit-total),events:records.length,bySource,lastEvent,note:'Contador interno de llamadas registradas por las funciones del portal.'})};
  }catch(error){
    return{statusCode:200,headers:HEADERS,body:JSON.stringify(emptyPayload(month,'El contador API devolvió un valor seguro en cero por una falla no crítica.',error.message))};
  }
};
