'use strict';

const fs=require('fs');
const target=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');
const oidcToken=String(process.env.VLA_ADMIN_OIDC_TOKEN||'');
if(!oidcToken)throw new Error('Falta VLA_ADMIN_OIDC_TOKEN.');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(url,options={},label='request'){
  let lastError;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const response=await fetch(url,options);
      if(response.ok)return response;
      const body=await response.text().catch(()=>'');
      throw new Error(`${label} respondió HTTP ${response.status}: ${body.slice(0,300)}`);
    }catch(error){
      lastError=error;
      if(attempt<3)await sleep(attempt*500);
    }
  }
  throw lastError;
}
async function jsonResponse(response,label){
  try{return await response.json()}
  catch(error){throw new Error(`${label} devolvió JSON inválido: ${error.message}`)}
}
async function adminFetch(token,path,options={}){
  const response=await request(`${target}${path}`,{
    ...options,
    headers:{'Content-Type':'application/json','Cache-Control':'no-cache',...(options.headers||{}),Authorization:`Bearer ${token}`}
  },path);
  return jsonResponse(response,path);
}

(async()=>{
  const exchange=await request(`${target}/.netlify/functions/admin-ci-readonly-session`,{
    method:'POST',
    headers:{'Content-Type':'application/json','Cache-Control':'no-cache'},
    body:JSON.stringify({oidcToken})
  },'admin-ci-readonly-session');
  const session=await jsonResponse(exchange,'admin-ci-readonly-session');
  if(session.success!==true||session.role!=='admin-ci-readonly'||session.source!=='github-oidc'||!session.token)throw new Error('Producción no emitió la sesión OIDC read-only esperada.');
  const token=session.token;

  const admin=await adminFetch(token,'/.netlify/functions/admin-data');
  const owners=Array.isArray(admin.propietarios)?admin.propietarios:[];
  if(owners.length!==15)throw new Error(`Admin protegido devolvió ${owners.length}/15 propietarios.`);
  const invalid=owners.filter(owner=>owner.balanceEngineVersion!=='vla-balance-contract-v7');
  if(invalid.length)throw new Error(`Contrato financiero no canónico en ${invalid.length} propietarios.`);

  const health=await adminFetch(token,'/.netlify/functions/system-health-advanced');
  const activeErrors=Array.isArray(health.checks)?health.checks.filter(check=>check.severity==='error'):[];
  if(health.status==='error'||activeErrors.length)throw new Error(`Health reportó fallas activas: ${activeErrors.map(check=>check.name).join(', ')||health.status}`);

  const mode=await adminFetch(token,'/.netlify/functions/access-mode');
  if(!mode.mode)throw new Error('No se pudo leer el modo del portón.');

  const mkj=await adminFetch(token,'/.netlify/functions/access-reconciliation-readonly');
  if(mkj.readOnly!==true||Number(mkj.total)!==15||Number(mkj.reconciled)!==15)throw new Error(`MKJ read-only incompleto: ${Number(mkj.reconciled)||0}/15.`);

  const close=await adminFetch(token,'/.netlify/functions/monthly-close',{method:'POST',body:JSON.stringify({dryRun:true})});
  if(!close.validation||!close.planHash)throw new Error('El cierre mensual DRY RUN no devolvió validation y planHash.');

  const evidence={
    target,
    authMode:'github-oidc-readonly',
    loginHttpStatus:exchange.status,
    loginSource:session.source,
    role:session.role,
    owners:owners.length,
    canonicalOwners:owners.length-invalid.length,
    health:health.status,
    healthErrors:activeErrors.length,
    accessMode:mode.mode,
    mkj:{
      readOnly:mkj.readOnly,
      total:Number(mkj.total),
      reconciled:Number(mkj.reconciled),
      coherent:Number(mkj.coherent||0),
      discrepancies:Number(mkj.discrepancyCount||0)
    },
    closeDryRun:true
  };
  fs.writeFileSync('admin-authenticated-readonly-result.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
})().catch(error=>{
  fs.writeFileSync('admin-authenticated-readonly-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
