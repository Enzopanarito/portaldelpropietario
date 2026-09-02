'use strict';

const fs=require('fs');
const {OWNER_BALANCE_CONTRACT}=require('../netlify/functions/_shared/_public_financial_contract');
const target=String(process.env.TARGET_URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');
const oidcToken=String(process.env.VLA_ADMIN_OIDC_TOKEN||'');
if(!oidcToken)throw new Error('Falta VLA_ADMIN_OIDC_TOKEN.');

const IDENTITY_REASONS=new Set(['MKJ_MEMBER_NOT_FOUND','MKJ_STATE_UNKNOWN','STALE_MEMBER_ID','EMAIL_MISMATCH']);
const STATE_REASONS=new Set(['MKJ_EXPECTATION_MISMATCH','AIRTABLE_EXPECTATION_MISMATCH']);
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
function classifyMkj(mkj){
  const rows=Array.isArray(mkj.discrepancies)?mkj.discrepancies:[];
  const details=rows.map(row=>{
    const reasons=Array.isArray(row.discrepancias)?row.discrepancias.map(String):[];
    const identityIssues=reasons.filter(reason=>IDENTITY_REASONS.has(reason));
    const stateIssues=reasons.filter(reason=>STATE_REASONS.has(reason));
    const otherIssues=reasons.filter(reason=>!IDENTITY_REASONS.has(reason)&&!STATE_REASONS.has(reason));
    const identityProblem=identityIssues.length>0||otherIssues.length>0;
    return{
      casa:Number(row.casa),
      identityIssues,
      stateIssues,
      otherIssues,
      ...(identityProblem?{storedMkjUserId:String(row.mkjUserIdAirtable||''),resolvedMkjUserId:String(row.mkjResolvedUserId||'')}:{}),
      exception:Boolean(row.excepcionAdministrativa),
      expected:String(row.estadoFisicoEsperado||''),
      airtable:String(row.estadoAirtable||''),
      mkj:String(row.estadoMkj||'')
    };
  });
  const identityRows=details.filter(row=>row.identityIssues.length||row.otherIssues.length);
  const stateRows=details.filter(row=>row.stateIssues.length);
  return{details,identityRows,stateRows};
}
function assertCloseDryRun(close){
  if(close.success!==true||close.dryRun!==true)throw new Error('El cierre mensual no confirmó modo DRY RUN.');
  if(!close.validation||!close.planHash||!close.sourceHash)throw new Error('El cierre mensual DRY RUN no devolvió validation, planHash y sourceHash.');
  if(!/^[a-f0-9]{64}$/.test(String(close.planHash)))throw new Error('planHash de cierre inválido.');
  if(!/^[a-f0-9]{64}$/.test(String(close.sourceHash)))throw new Error('sourceHash de cierre inválido.');
  if(Number(close.validation.ownerCount)!==15)throw new Error(`DRY RUN devolvió ${Number(close.validation.ownerCount)||0}/15 propietarios.`);
  if(!Array.isArray(close.ownerPlan)||close.ownerPlan.length!==15)throw new Error(`DRY RUN no devolvió plan detallado 15/15: ${Array.isArray(close.ownerPlan)?close.ownerPlan.length:0}/15.`);
  const houses=close.ownerPlan.map(row=>Number(row.casa)).sort((a,b)=>a-b);
  if(houses.some((house,index)=>house!==index+1))throw new Error('DRY RUN no contiene la secuencia canónica de casas 1..15.');
  const snapshot=close.snapshot||{};
  if(Number(snapshot.expected)!==150)throw new Error(`Snapshot esperaba ${Number(snapshot.expected)||0}/150 filas.`);
  if(!close.closeWindow||typeof close.closeWindow.ok!=='boolean')throw new Error('DRY RUN no devolvió el estado de ventana de cierre.');
  if(close.validation.closeScopeReady===false)throw new Error(`DRY RUN bloqueado por ${Number(close.validation.invalidPaymentDatesCount)||0} pago(s) sin fecha válida.`);
}
function canonicalOwnerPlan(plan){
  return JSON.stringify((Array.isArray(plan)?plan:[]).map(row=>({
    id:String(row.id||''),
    casa:Number(row.casa),
    before:row.before||{},
    target:row.target||{},
    calculation:row.calculation||{}
  })).sort((a,b)=>a.casa-b.casa));
}

(async()=>{
  const exchange=await request(`${target}/.netlify/functions/admin-ci-readonly-session`,{
    method:'POST',headers:{'Content-Type':'application/json','Cache-Control':'no-cache'},body:JSON.stringify({oidcToken})
  },'admin-ci-readonly-session');
  const session=await jsonResponse(exchange,'admin-ci-readonly-session');
  if(session.success!==true||session.role!=='admin-ci-readonly'||session.source!=='github-oidc'||!session.token)throw new Error('Producción no emitió la sesión OIDC read-only esperada.');
  const token=session.token;

  const admin=await adminFetch(token,'/.netlify/functions/admin-data');
  const owners=Array.isArray(admin.propietarios)?admin.propietarios:[];
  if(owners.length!==15)throw new Error(`Admin protegido devolvió ${owners.length}/15 propietarios.`);
  const invalid=owners.filter(owner=>owner.balanceEngineVersion!==OWNER_BALANCE_CONTRACT);
  if(invalid.length)throw new Error(`Contrato financiero no canónico en ${invalid.length} propietarios.`);

  const health=await adminFetch(token,'/.netlify/functions/system-health-advanced');
  const activeErrors=Array.isArray(health.checks)?health.checks.filter(check=>check.severity==='error'):[];
  const healthFailureMessage=(health.status==='error'||activeErrors.length)?`Health reportó fallas activas: ${activeErrors.map(check=>check.name).join(', ')||health.status}`:'';

  const mode=await adminFetch(token,'/.netlify/functions/access-mode');
  if(!mode.mode)throw new Error('No se pudo leer el modo del portón.');

  const mkj=await adminFetch(token,'/.netlify/functions/access-reconciliation-readonly');
  if(mkj.readOnly!==true||Number(mkj.total)!==15||Number(mkj.reconciled)!==15)throw new Error(`MKJ read-only incompleto: ${Number(mkj.reconciled)||0}/15.`);
  const mkjClassification=classifyMkj(mkj);

  const closeRequest={method:'POST',body:JSON.stringify({dryRun:true})};
  const close=await adminFetch(token,'/.netlify/functions/monthly-close',closeRequest);
  const closeRepeat=await adminFetch(token,'/.netlify/functions/monthly-close',closeRequest);
  assertCloseDryRun(close);
  assertCloseDryRun(closeRepeat);
  if(String(close.planHash)!==String(closeRepeat.planHash))throw new Error(`DRY RUN no reproducible: planHash ${close.planHash} != ${closeRepeat.planHash}.`);
  if(String(close.sourceHash)!==String(closeRepeat.sourceHash))throw new Error(`DRY RUN no reproducible: sourceHash ${close.sourceHash} != ${closeRepeat.sourceHash}.`);
  if(canonicalOwnerPlan(close.ownerPlan)!==canonicalOwnerPlan(closeRepeat.ownerPlan))throw new Error('DRY RUN no reproducible: el plan 15/15 cambió entre dos lecturas consecutivas.');

  const evidence={
    target,
    capturedAt:new Date().toISOString(),
    authMode:'github-oidc-readonly',
    loginHttpStatus:exchange.status,
    loginSource:session.source,
    role:session.role,
    owners:owners.length,
    canonicalOwners:owners.length-invalid.length,
    health:health.status,
    healthErrors:activeErrors.length,
    healthFailureMessage,
    accessMode:mode.mode,
    mkj:{readOnly:mkj.readOnly,total:Number(mkj.total),reconciled:Number(mkj.reconciled),coherent:Number(mkj.coherent||0),discrepancies:Number(mkj.discrepancyCount||0),identityIssueRows:mkjClassification.identityRows.length,stateDivergenceRows:mkjClassification.stateRows.length,manualStateDivergences:mode.mode==='Manual'?mkjClassification.stateRows.length:0,discrepancyDetails:mkjClassification.details},
    closeDryRun:{
      success:true,
      reproducible:true,
      month:String(close.month||''),
      monthDefaulted:Boolean(close.monthDefaulted),
      planHash:String(close.planHash),
      repeatPlanHash:String(closeRepeat.planHash),
      sourceHash:String(close.sourceHash),
      repeatSourceHash:String(closeRepeat.sourceHash),
      ownerCount:Number(close.validation.ownerCount),
      paymentCutoff:String(close.validation.paymentCutoff||''),
      pendingPaymentsCount:Number(close.validation.pendingPaymentsCount||0),
      invalidPaymentDatesCount:Number(close.validation.invalidPaymentDatesCount||0),
      futurePaymentsExcludedCount:Number(close.validation.futurePaymentsExcludedCount||0),
      totalUsd:Number(close.validation.totalUsd||0),
      totalBsRef:Number(close.validation.totalBsRef||0),
      totalRef:Number(close.validation.totalRef||0),
      creditBalanceCount:Number(close.validation.creditBalanceCount||0),
      currencyCreditComponentCount:Number(close.validation.currencyCreditComponentCount||0),
      snapshot:close.snapshot,
      closeWindow:close.closeWindow,
      closeStatus:String(close.closeStatus||''),
      canExecute:Boolean(close.canExecute),
      closeCertification:close.closeCertification||null,
      ownerPlan:close.ownerPlan
    }
  };
  fs.writeFileSync('admin-authenticated-readonly-result.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));

  if(close.closeStatus==='already-closed-unverified'){
    const reason=String(close.closeCertification?.reason||'UNKNOWN');
    throw new Error(`Cierre ${close.month||''} marcado DONE pero no certificado: ${reason}.`);
  }
  if(close.closeStatus==='already-closed'&&close.closeCertification&&close.closeCertification.ok!==true)throw new Error(`Cierre ${close.month||''} no presentó certificación histórica válida.`);
  if(healthFailureMessage)throw new Error(healthFailureMessage);
  if(mkjClassification.identityRows.length)throw new Error(`MKJ tiene ${mkjClassification.identityRows.length} casa(s) con problemas de identidad/lectura: ${mkjClassification.identityRows.map(row=>`Casa ${row.casa} [${[...row.identityIssues,...row.otherIssues].join(',')}] stored=${row.storedMkjUserId||'none'} resolved=${row.resolvedMkjUserId||'none'}`).join('; ')}`);
  if(mode.mode==='Automático'&&mkjClassification.stateRows.length)throw new Error(`MKJ automático tiene ${mkjClassification.stateRows.length} discrepancia(s) de estado.`);
})().catch(error=>{
  fs.writeFileSync('admin-authenticated-readonly-error.txt',String(error.stack||error));
  console.error(error.stack||error);
  process.exit(1);
});
