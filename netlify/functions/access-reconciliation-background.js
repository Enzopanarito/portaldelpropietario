'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {verify}=require('./_shared/_internal_job_auth');
const {getAccessMode,getAutomationRules,autoSyncAll,ACCESS_MODE_AUTO}=require('./_shared/_access_control');
const {runReadOnlyReconciliation}=require('./_shared/_access_reconciliation_readonly');

const AUTO_REPAIRABLE_REASONS=new Set(['MKJ_EXPECTATION_MISMATCH','AIRTABLE_EXPECTATION_MISMATCH']);

function response(statusCode,body){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

function classifyRepairability(audit){
 const discrepancies=Array.isArray(audit?.discrepancies)?audit.discrepancies:[];
 const repairable=[];
 const unsafe=[];
 for(const row of discrepancies){
  const reasons=Array.isArray(row?.discrepancias)?row.discrepancias.map(String):[];
  if(reasons.length&&reasons.every(reason=>AUTO_REPAIRABLE_REASONS.has(reason)))repairable.push(row);
  else unsafe.push(row);
 }
 return{repairable,unsafe};
}

const handler=async function(event){
 const rawBody=event.body||'';
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 if(!verify(rawBody,event.headers||{}))return response(401,{message:'No autorizado.'});
 try{
  const mode=await getAccessMode(),automation=await getAutomationRules(mode);
  if(mode.mode!==ACCESS_MODE_AUTO||!automation.configured||!automation.rules.masterEnabled||!automation.rules.access.automaticEnabled){
   return response(200,{success:true,skipped:true,reason:mode.mode!==ACCESS_MODE_AUTO?'MANUAL_MODE':'ACCESS_AUTOMATION_DISABLED'});
  }

  const audit=await runReadOnlyReconciliation();
  const classification=classifyRepairability(audit);

  if(!classification.repairable.length&&!classification.unsafe.length){
   return response(200,{
    success:true,
    unchanged:true,
    total:Number(audit.total||0),
    coherent:Number(audit.coherent||0),
    discrepancies:0,
    message:'MKJ y Airtable ya están coherentes; no fue necesario escribir.'
   });
  }

  if(classification.unsafe.length){
   return response(500,{
    success:false,
    blocked:true,
    reason:'UNSAFE_MKJ_DISCREPANCY',
    message:'La reconciliación detectó una discrepancia que requiere revisión humana; no se aplicaron cambios.',
    discrepancies:classification.unsafe.map(row=>({
     casa:Number(row.casa||0),
     reasons:Array.isArray(row.discrepancias)?row.discrepancias.map(String):[]
    }))
   });
  }

  const result=await autoSyncAll({forceMkj:true,sendEmail:true,touchUnchanged:false});
  if(!result.success){
   return response(500,{
    success:false,
    reason:'MKJ_REPAIR_FAILED',
    message:'La resincronización automática no terminó limpia.',
    repairableHouses:classification.repairable.map(row=>Number(row.casa||0)),
    ...result
   });
  }

  const verification=await runReadOnlyReconciliation();
  if(Number(verification.discrepancyCount||0)!==0){
   return response(500,{
    success:false,
    reason:'MKJ_REPAIR_NOT_VERIFIED',
    message:'Se ejecutó la resincronización, pero la verificación posterior todavía detecta discrepancias.',
    repairableHouses:classification.repairable.map(row=>Number(row.casa||0)),
    verification:{
     total:Number(verification.total||0),
     coherent:Number(verification.coherent||0),
     discrepancyCount:Number(verification.discrepancyCount||0),
     discrepancies:(verification.discrepancies||[]).map(row=>({
      casa:Number(row.casa||0),
      reasons:Array.isArray(row.discrepancias)?row.discrepancias.map(String):[]
     }))
    }
   });
  }

  return response(200,{
   success:true,
   repaired:true,
   repairableHouses:classification.repairable.map(row=>Number(row.casa||0)),
   reconciled:result.results.filter(item=>!item.unchanged&&!item.skipped&&!item.error).length,
   total:Number(verification.total||0),
   coherent:Number(verification.coherent||0),
   discrepancyCount:0,
   message:'Discrepancias de estado reparadas y verificadas contra MKJ.'
  });
 }catch(error){
  return response(500,{success:false,message:'Falló la reconciliación periódica del portón.',detail:String(error.message||error).slice(0,300)});
 }
};

exports.AUTO_REPAIRABLE_REASONS=AUTO_REPAIRABLE_REASONS;
exports.classifyRepairability=classifyRepairability;
exports.handler=withAirtableUsage('access-reconciliation-background',handler);
