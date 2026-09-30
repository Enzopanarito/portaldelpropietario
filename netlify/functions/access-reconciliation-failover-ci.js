'use strict';

const {verifyAccessFailoverOidcToken}=require('./_shared/_github_oidc_access_failover');
const {runReadOnlyReconciliation}=require('./_shared/_access_reconciliation_readonly');
const {
  getAccessMode,getAutomationRules,loadAccessContext,syncOwnerAccess,ACCESS_MODE_AUTO
}=require('./_shared/_access_control');

const REPAIRABLE_REASONS=new Set(['MKJ_EXPECTATION_MISMATCH','AIRTABLE_EXPECTATION_MISMATCH']);

function response(statusCode,body,headers={}){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)};
}
function isRepairable(row){
 const reasons=Array.isArray(row?.discrepancias)?row.discrepancias.map(String):[];
 return reasons.length>0&&reasons.every(reason=>REPAIRABLE_REASONS.has(reason));
}

exports.handler=async function(event){
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 let body={};
 try{body=JSON.parse(event.body||'{}')}catch(_){return response(400,{message:'Solicitud inválida.'})}
 const oidcToken=String(body.oidcToken||'');
 const mode=String(body.mode||'dispatch').toLowerCase();
 if(!oidcToken||oidcToken.length>20000)return response(401,{message:'Identidad CI no válida.'});
 if(!['probe','dispatch'].includes(mode))return response(400,{message:'Modo inválido.'});

 let claims;
 try{claims=await verifyAccessFailoverOidcToken(oidcToken)}
 catch(error){
  console.warn(JSON.stringify({event:'VLA_ACCESS_FAILOVER_OIDC_REJECTED',code:String(error.message||'OIDC_REJECTED').slice(0,80)}));
  return response(401,{message:'Identidad CI no autorizada.'});
 }

 if(mode==='probe'){
  return response(200,{success:true,authenticated:true,dispatched:false,source:'github-oidc-access-probe'});
 }

 try{
  const before=await runReadOnlyReconciliation();
  const repairable=(before.discrepancies||[]).filter(isRepairable);
  const unsafe=(before.discrepancies||[]).filter(row=>!isRepairable(row));

  if(unsafe.length){
    return response(409,{
      success:false,
      blocked:true,
      reason:'UNSAFE_ACCESS_DISCREPANCY',
      message:'Se detectó una discrepancia de identidad o lectura que no admite reparación automática.',
      discrepancies:unsafe.map(row=>({casa:Number(row.casa||0),reasons:row.discrepancias||[]}))
    });
  }

  if(!repairable.length){
    return response(200,{
      success:true,
      verified:true,
      repaired:false,
      total:Number(before.total||0),
      coherent:Number(before.coherent||0),
      discrepancyCount:Number(before.discrepancyCount||0),
      source:'github-oidc-access-failover'
    },{'X-VLA-Access-Failover':'verified'});
  }

  const modeInfo=await getAccessMode();
  const automationInfo=await getAutomationRules(modeInfo);
  if(modeInfo.mode!==ACCESS_MODE_AUTO||!automationInfo.configured||!automationInfo.rules.masterEnabled||!automationInfo.rules.access.automaticEnabled){
    return response(409,{success:false,blocked:true,reason:'ACCESS_AUTOMATION_DISABLED'});
  }

  const context=await loadAccessContext();
  const results=[];
  for(const row of repairable){
    const owner=(context.owners||[]).find(item=>Number(item?.fields?.Casa||0)===Number(row.casa||0));
    if(!owner){
      results.push({casa:Number(row.casa||0),error:'OWNER_NOT_FOUND'});
      continue;
    }
    try{
      const result=await syncOwnerAccess(owner.id,{
        forceMkj:true,
        sendEmail:false,
        touchUnchanged:false,
        modeInfo,
        automationInfo
      },context);
      results.push({casa:Number(row.casa||0),ok:!result.error,estado:result.estado,mkjStatus:result.mkjStatus||null});
    }catch(error){
      results.push({casa:Number(row.casa||0),error:String(error.message||error).slice(0,180)});
    }
  }

  if(results.some(item=>item.error)){
    return response(500,{success:false,reason:'ACCESS_REPAIR_FAILED',results});
  }

  const after=await runReadOnlyReconciliation();
  if(Number(after.discrepancyCount||0)!==0||Number(after.coherent||0)!==Number(after.total||0)){
    return response(500,{
      success:false,
      reason:'ACCESS_REPAIR_NOT_VERIFIED',
      results,
      verification:{
        total:Number(after.total||0),
        coherent:Number(after.coherent||0),
        discrepancyCount:Number(after.discrepancyCount||0),
        discrepancies:(after.discrepancies||[]).map(row=>({casa:Number(row.casa||0),reasons:row.discrepancias||[]}))
      }
    });
  }

  console.log(JSON.stringify({
    event:'VLA_ACCESS_FAILOVER_VERIFIED',
    githubRunId:String(claims.run_id||''),
    repairedHouses:repairable.map(row=>Number(row.casa||0))
  }));
  return response(200,{
    success:true,
    verified:true,
    repaired:true,
    repairedHouses:repairable.map(row=>Number(row.casa||0)),
    total:Number(after.total||0),
    coherent:Number(after.coherent||0),
    discrepancyCount:0,
    results,
    source:'github-oidc-access-failover'
  },{'X-VLA-Access-Failover':'verified'});
 }catch(error){
  console.error(JSON.stringify({event:'VLA_ACCESS_FAILOVER_FAILED',code:String(error.message||'FAILOVER_FAILED').slice(0,160)}));
  return response(500,{success:false,message:'Falló la reconciliación verificada de respaldo.'});
 }
};

exports.REPAIRABLE_REASONS=REPAIRABLE_REASONS;
exports.isRepairable=isRepairable;
