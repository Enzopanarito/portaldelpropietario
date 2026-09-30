'use strict';

const {verifyAccessFailoverOidcToken}=require('./_shared/_github_oidc_access_failover');
const {sign}=require('./_shared/_internal_job_auth');
const {resolveInternalSiteUrl}=require('./_shared/_internal_site_url');

function response(statusCode,body,headers={}){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)};
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
  const site=resolveInternalSiteUrl(process.env);
  const payload=JSON.stringify({
   requestedAt:new Date().toISOString(),
   source:'github-oidc-access-failover',
   githubRunId:String(claims.run_id||'')
  });
  const authorization=sign(payload);
  const queued=await fetch(`${site}/api/vla/access-reconciliation`,{
   method:'POST',
   headers:{
    'Content-Type':'application/json',
    'x-vla-job-timestamp':authorization.timestamp,
    'x-vla-job-signature':authorization.signature
   },
   body:payload
  });
  if(!queued.ok)throw new Error(`La cola de reconciliación respondió HTTP ${queued.status}.`);
  console.log(JSON.stringify({event:'VLA_ACCESS_FAILOVER_QUEUED',githubRunId:String(claims.run_id||'')}));
  return response(202,{success:true,queued:true,dispatched:true,source:'github-oidc-access-failover'},{'X-VLA-Access-Failover':'queued'});
 }catch(error){
  console.error(JSON.stringify({event:'VLA_ACCESS_FAILOVER_FAILED',code:String(error.message||'FAILOVER_FAILED').slice(0,160)}));
  return response(500,{success:false,dispatched:false,message:'No se pudo disparar la reconciliación de respaldo.'});
 }
};
