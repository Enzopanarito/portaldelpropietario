'use strict';

const path=require('path');
const migration=require('./smart-payment-airtable-migrate');
const {FIELDS,STATUS,ORIGIN,currentMonthCaracas}=require('../netlify/functions/_shared/_expense_lifecycle');

const DATA_ROOT='https://api.airtable.com/v0';
const ALLOWED_MODES=new Set(['plan','verify','apply']);

function clean(value){return String(value??'').trim()}
function buildBackfillPlan(records,{month=currentMonthCaracas(),now=new Date()}={}){
 const updates=[];
 for(const record of records||[]){
  const fields=record.fields||{},patch={};
  if(!clean(fields[FIELDS.month]))patch[FIELDS.month]=month;
  if(!clean(fields[FIELDS.status]))patch[FIELDS.status]=STATUS.ACTIVE;
  if(!clean(fields[FIELDS.origin]))patch[FIELDS.origin]=ORIGIN.MANUAL;
  if(!fields[FIELDS.activatedAt])patch[FIELDS.activatedAt]=now.toISOString();
  if(Object.keys(patch).length)updates.push({id:record.id,fields:patch});
 }
 return{schemaVersion:1,month,recordCount:(records||[]).length,updateCount:updates.length,updates};
}
async function listAll(baseId,tableId,token){
 let records=[],offset=null;
 do{
  const query=`?pageSize=100${offset?`&offset=${encodeURIComponent(offset)}`:''}`;
  const data=await migration.apiRequest(`${DATA_ROOT}/${baseId}/${encodeURIComponent(tableId)}${query}`,{token});
  records=records.concat(data.records||[]);offset=data.offset||null;
 }while(offset);
 return records;
}
async function patchBatches(baseId,tableId,updates,token){
 const patched=[];
 for(let index=0;index<updates.length;index+=10){
  const batch=updates.slice(index,index+10);
  const data=await migration.apiRequest(`${DATA_ROOT}/${baseId}/${encodeURIComponent(tableId)}`,{token,method:'PATCH',body:{records:batch,typecast:true}});
  patched.push(...(data.records||[]));
 }
 return patched;
}
function validateTarget({mode,environment,baseId,confirmation}){
 if(!ALLOWED_MODES.has(mode))throw new Error('Modo inválido. Use plan, verify o apply.');
 const expected=environment==='production'?migration.PRODUCTION_BASE_ID:migration.STAGING_BASE_ID;
 if(!['production','staging'].includes(environment)||baseId!==expected)throw new Error('El entorno y el Base ID no coinciden.');
 if(mode==='apply'){
  const phrase=environment==='production'?'APPLY_EXPENSE_LIFECYCLE_V1_TO_PRODUCTION':'APPLY_EXPENSE_LIFECYCLE_V1_TO_STAGING';
  if(confirmation!==phrase)throw new Error(`Falta la confirmación exacta ${phrase}.`);
 }
}
async function main(){
 const mode=clean(process.argv[2]||'plan').toLowerCase(),environment=clean(process.env.AIRTABLE_TARGET_ENVIRONMENT||'staging').toLowerCase(),baseId=clean(process.env.AIRTABLE_TARGET_BASE_ID||(environment==='production'?migration.PRODUCTION_BASE_ID:migration.STAGING_BASE_ID)),token=clean(process.env.AIRTABLE_API_TOKEN),confirmation=clean(process.env.EXPENSE_LIFECYCLE_CONFIRM);
 validateTarget({mode,environment,baseId,confirmation});if(!token)throw new Error('Falta AIRTABLE_API_TOKEN.');
 const metadata=await migration.fetchMetadata(baseId,{token}),table=(metadata.tables||[]).find(item=>migration.fold(item.name)===migration.fold('Gastos del Mes'));
 if(!table)throw new Error('No existe la tabla Gastos del Mes.');
 const required=[FIELDS.month,FIELDS.status,FIELDS.origin,FIELDS.activatedAt],available=new Set((table.fields||[]).map(field=>migration.fold(field.name)));
 const missing=required.filter(name=>!available.has(migration.fold(name)));if(missing.length)throw new Error(`Ejecute primero la migración de esquema. Faltan: ${missing.join(', ')}.`);
 const records=await listAll(baseId,table.id,token),plan=buildBackfillPlan(records),planFile=migration.writeArtifact('expense-lifecycle-v1-plan',{environment,baseId,...plan});
 console.log(JSON.stringify({mode,environment,baseId,planFile,recordCount:plan.recordCount,updateCount:plan.updateCount}));
 if(mode==='plan')return;
 if(mode==='verify'){if(plan.updateCount)throw new Error(`Quedan ${plan.updateCount} gasto(s) sin ciclo de vida.`);console.log('EXPENSE_LIFECYCLE_V1_VERIFIED');return}
 const patched=await patchBatches(baseId,table.id,plan.updates,token),after=buildBackfillPlan(await listAll(baseId,table.id,token));
 if(after.updateCount)throw new Error(`La verificación posterior detectó ${after.updateCount} registro(s) pendientes.`);
 const ledger={migration:'EXPENSE_LIFECYCLE_V1',environment,baseId,month:plan.month,appliedAt:new Date().toISOString(),updatedIds:patched.map(record=>record.id),status:'DONE'};
 const ledgerFile=migration.writeArtifact('expense-lifecycle-v1-ledger',ledger);
 console.log(JSON.stringify({applied:true,updatedCount:patched.length,ledgerFile,status:'DONE'}));
}

if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exit(1)});
module.exports={buildBackfillPlan,validateTarget,listAll,patchBatches};
