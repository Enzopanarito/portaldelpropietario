'use strict';

const {verifyAutopilotFailoverOidcToken}=require('./_shared/_github_oidc_autopilot');
const {sign}=require('./_shared/_internal_job_auth');

function response(statusCode,body,headers={}){
 return{
  statusCode,
  headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers},
  body:JSON.stringify(body)
 };
}
function caracasClock(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{
  timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
 }).formatToParts(now);
 const get=type=>parts.find(part=>part.type===type)?.value||'';
 return{
  date:`${get('year')}-${get('month')}-${get('day')}`,
  day:Number(get('day')||0),
  hour:Number(get('hour')||0),
  minute:Number(get('minute')||0)
 };
}
function isRecoveryWindow(clock){return Number(clock?.day)>=1&&Number(clock?.day)<=3}

exports.handler=async function(event){
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 let body={};
 try{body=JSON.parse(event.body||'{}')}catch(_){return response(400,{message:'Solicitud inválida.'})}
 const oidcToken=String(body.oidcToken||'');
 const mode=String(body.mode||'dispatch').toLowerCase();
 if(!oidcToken||oidcToken.length>20000)return response(401,{message:'Identidad CI no válida.'});
 if(!['probe','dispatch'].includes(mode))return response(400,{message:'Modo inválido.'});

 let claims;
 try{claims=await verifyAutopilotFailoverOidcToken(oidcToken)}
 catch(error){
  console.warn(JSON.stringify({event:'VLA_AUTOPILOT_FAILOVER_OIDC_REJECTED',code:String(error.message||'OIDC_REJECTED').slice(0,80)}));
  return response(401,{message:'Identidad CI no autorizada.'});
 }

 const clock=caracasClock();
 const windowOpen=isRecoveryWindow(clock);
 if(mode==='probe'){
  return response(200,{
   success:true,
   authenticated:true,
   dispatched:false,
   windowOpen,
   date:clock.date,
   source:'github-oidc-autopilot-probe'
  });
 }
 if(!windowOpen){
  return response(409,{
   success:false,
   dispatched:false,
   reason:'OUTSIDE_CLOSE_RECOVERY_WINDOW',
   date:clock.date,
   message:'El rescate automático solo puede disparar el piloto durante los días 1 al 3 en America/Caracas.'
  });
 }

 try{
  const site=String(process.env.URL||'').replace(/\/$/,'');
  if(!site)throw new Error('Falta URL del sitio.');
  const payload=JSON.stringify({
   requestedAt:new Date().toISOString(),
   source:'github-oidc-autopilot-failover',
   githubRunId:String(claims.run_id||'')
  });
  const authorization=sign(payload);
  const queued=await fetch(`${site}/api/vla/condo-autopilot`,{
   method:'POST',
   headers:{
    'Content-Type':'application/json',
    'x-vla-job-timestamp':authorization.timestamp,
    'x-vla-job-signature':authorization.signature
   },
   body:payload
  });
  if(!queued.ok)throw new Error(`La cola del piloto respondió HTTP ${queued.status}.`);
  console.log(JSON.stringify({event:'VLA_AUTOPILOT_FAILOVER_QUEUED',date:clock.date,githubRunId:String(claims.run_id||'')}));
  return response(202,{
   success:true,
   queued:true,
   dispatched:true,
   date:clock.date,
   source:'github-oidc-autopilot-failover'
  },{'X-VLA-Autopilot-Failover':'queued'});
 }catch(error){
  console.error(JSON.stringify({event:'VLA_AUTOPILOT_FAILOVER_FAILED',code:String(error.message||'FAILOVER_FAILED').slice(0,160)}));
  return response(500,{success:false,dispatched:false,message:'No se pudo disparar el piloto de respaldo.'});
 }
};

exports.caracasClock=caracasClock;
exports.isRecoveryWindow=isRecoveryWindow;
