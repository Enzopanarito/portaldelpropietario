'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { requireAdmin } = require('./_shared/_auth');
const { assertLabDataIsolation, isLab, STAGING_BASE_ID } = require('./_shared/_lab_guard');
const { deepEscapeStrings, safeDisplayText } = require('./_shared/_security_utils');
const { calculateAllOwners, calculatedFields } = require('./_shared/_balance_engine_v4');
const { filterActiveExpenses, currentMonthCaracas, STATUS, statusOf, monthOf } = require('./_shared/_expense_lifecycle');
const { mergeConfig } = require('./_shared/_automation_rules');
const { synchronizePayload } = require('./admin-data-v3');

const TABLES = Object.freeze({
  propietarios:'Propietarios', gastos:'Gastos del Mes', pagos:'Pagos',
  reportes:'Reportes de Pago', config:'Configuración', control:'ControlVersiones'
});
const HEADERS = {'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-VLA-LAB-Admin-Data':'isolated-staging'};
function json(statusCode,body){return{statusCode,headers:HEADERS,body:JSON.stringify(body)}}
function endpoint(table,query=''){return`https://api.airtable.com/v0/${STAGING_BASE_ID}/${encodeURIComponent(table)}${query}`}
async function listAll(table,query=''){
  let records=[],offset='';
  do{
    const joiner=query?'&':'?';
    const suffix=offset?`${joiner}offset=${encodeURIComponent(offset)}`:'';
    const response=await fetch(endpoint(table,query+suffix),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN||''}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||`No se pudo leer ${table} de staging.`);
    records=records.concat(data.records||[]);offset=data.offset||'';
  }while(offset);
  return records;
}
function onlyPending(records){return(records||[]).filter(record=>String(record?.fields?.Estado||'').trim().toLowerCase()==='pendiente')}
function flattenOwner(record,balance){return Object.assign({id:record.id},record.fields||{},calculatedFields(balance,record))}

const handler=async function(event){
  if(!isLab(process.env))return json(404,{message:'Not Found'});
  const auth=requireAdmin(event);if(!auth.ok)return auth.response;
  if(event.httpMethod!=='GET')return json(405,{message:'Method Not Allowed'});
  try{
    const isolation=assertLabDataIsolation(process.env);
    if(isolation.baseId!==STAGING_BASE_ID)return json(503,{message:'VLA LAB no está aislado en staging.'});
    const [rawOwners,allExpenses,payments,reports,configs,controlRecords]=await Promise.all([
      listAll(TABLES.propietarios),listAll(TABLES.gastos),listAll(TABLES.pagos),
      listAll(TABLES.reportes),listAll(TABLES.config,'?maxRecords=1'),listAll(TABLES.control)
    ]);
    if(rawOwners.length!==15)return json(503,{message:`STAGING inválido: ${rawOwners.length}/15 propietarios.`});
    const houses=rawOwners.map(record=>Number(record?.fields?.Casa||0)).sort((a,b)=>a-b);
    if(houses.some((house,index)=>house!==index+1))return json(503,{message:'STAGING inválido: casas ficticias no son 1..15.'});
    const gastos=filterActiveExpenses(allExpenses,currentMonthCaracas());
    const gastosProgramados=allExpenses.filter(record=>statusOf(record)===STATUS.SCHEDULED&&monthOf(record)>currentMonthCaracas());
    const rules=mergeConfig(configs[0]||{});
    const balances=calculateAllOwners(rawOwners,gastos,payments,{dueDay:rules.payment.dueDay,surchargeRate:rules.payment.surchargeRate});
    const propietarios=rawOwners.map(record=>flattenOwner(record,balances.get(record.id))).sort((a,b)=>Number(a.Casa||0)-Number(b.Casa||0));
    const payload=deepEscapeStrings({
      generatedAt:new Date().toISOString(),
      generatedAtCaracas:new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date()),
      balanceEngineVersion:4,propietarios,gastos,gastosProgramados,pagos:payments,reportes:onlyPending(reports),warnings:[],partial:false,
      lab:true,dataEnvironment:'staging'
    });
    const canonical=synchronizePayload(payload,controlRecords);
    if((canonical.propietarios||[]).length!==15)return json(503,{message:'Contrato canónico LAB no devolvió 15 casas.'});
    return json(200,canonical);
  }catch(error){return json(503,{message:'No se pudo cargar el conjunto ficticio del VLA LAB.',detail:safeDisplayText(error.message,400)});}
};

exports.handler=withAirtableUsage('admin-data-lab',handler);