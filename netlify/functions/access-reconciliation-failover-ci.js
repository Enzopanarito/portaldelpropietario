'use strict';

const {verifyAccessFailoverOidcToken}=require('./_shared/_github_oidc_access_failover');
const {performAccessReconciliation}=require('./access-reconciliation-background');

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
  return response(200,{success:true,authenticated:true,verified:false,source:'github-oidc-access-probe'});
 }

 try{
  const outcome=await performAccessReconciliation();
  const payload={
   ...outcome.body,
   githubRunId:String(claims.run_id||''),
   source:'github-oidc-access-failover-verified'
  };
  if(outcome.statusCode!==200||payload.success!==true){
   console.error(JSON.stringify({event:'VLA_ACCESS_FAILOVER_REPAIR_FAILED',reason:String(payload.reason||'REPAIR_FAILED'),githubRunId:String(claims.run_id||'')}));
   return response(500,payload,{'X-VLA-Access-Failover':'failed'});
  }
  console.log(JSON.stringify({
   event:'VLA_ACCESS_FAILOVER_VERIFIED',
   repaired:payload.repaired===true,
   coherent:Number(payload.coherent||payload.total||0),
   githubRunId:String(claims.run_id||'')
  }));
  return response(200,payload,{'X-VLA-Access-Failover':'verified'});
 }catch(error){
  console.error(JSON.stringify({event:'VLA_ACCESS_FAILOVER_FAILED',code:String(error.message||'FAILOVER_FAILED').slice(0,160)}));
  return response(500,{success:false,verified:false,message:'No se pudo completar y verificar la reconciliación de respaldo.',detail:String(error.message||'').slice(0,300)});
 }
};
