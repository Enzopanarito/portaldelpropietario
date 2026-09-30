'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const oidc=require('../netlify/functions/_shared/_github_oidc_access_failover');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

function validClaims(overrides={}){
 const now=2_000_000_000;
 return{
  now,
  claims:{
   iss:oidc.ISSUER,
   aud:oidc.AUDIENCE,
   repository:oidc.REPOSITORY,
   repository_owner:oidc.REPOSITORY_OWNER,
   workflow:oidc.WORKFLOW,
   workflow_ref:oidc.WORKFLOW_REF,
   ref:oidc.REF,
   event_name:'schedule',
   runner_environment:'github-hosted',
   run_id:'654321',
   iat:now-30,
   nbf:now-30,
   exp:now+300,
   ...overrides
  }
 };
}

test('OIDC de reconciliación queda limitado a repo, workflow y eventos autorizados',()=>{
 const {claims,now}=validClaims();
 assert.equal(oidc.validateClaims(claims,now).run_id,'654321');
 for(const [field,value,code] of [
  ['aud','otro','OIDC_AUDIENCE_INVALID'],
  ['workflow','Otro','OIDC_WORKFLOW_INVALID'],
  ['ref','refs/heads/feature','OIDC_REF_INVALID'],
  ['event_name','pull_request','OIDC_EVENT_INVALID']
 ]){
  assert.throws(()=>oidc.validateClaims({...claims,[field]:value},now),new RegExp(code));
 }
 assert.equal(oidc.validateClaims({...claims,event_name:'workflow_run'},now).event_name,'workflow_run');
});

test('endpoint de failover ejecuta y verifica reconciliación real, no confunde 202 con éxito',()=>{
 const source=read('netlify/functions/access-reconciliation-failover-ci.js');
 assert.match(source,/verifyAccessFailoverOidcToken/);
 assert.match(source,/performAccessReconciliation/);
 assert.match(source,/VLA_ACCESS_FAILOVER_VERIFIED/);
 assert.match(source,/outcome\.statusCode!==200/);
 assert.doesNotMatch(source,/\/api\/vla\/access-reconciliation/);
 assert.doesNotMatch(source,/monthly-close/);
 assert.doesNotMatch(source,/AIRTABLE_API_TOKEN/);
 assert.doesNotMatch(source,/MKJ_ADMIN_PASSWORD/);
});

test('reconciliador exporta una ejecución verificable reutilizable por background y failover',()=>{
 const source=read('netlify/functions/access-reconciliation-background.js');
 assert.match(source,/async function performAccessReconciliation\(\)/);
 assert.match(source,/autoSyncAll\(\{forceMkj:true/);
 assert.match(source,/runReadOnlyReconciliation\(\)/);
 assert.match(source,/MKJ_REPAIR_NOT_VERIFIED/);
 assert.match(source,/exports\.performAccessReconciliation=performAccessReconciliation/);
});

test('workflow de respaldo corre cada hora, después de deploy y exige HTTP 200 verificado',()=>{
 const source=read('.github/workflows/access-reconciliation-failover.yml');
 assert.match(source,/cron: '15 \* \* \* \*'/);
 assert.match(source,/workflows: \["Deploy Netlify Production"\]/);
 assert.match(source,/audience=vla-access-reconciliation-failover/);
 assert.match(source,/default: probe/);
 assert.match(source,/id-token: write/);
 assert.match(source,/expected=200/);
 assert.doesNotMatch(source,/expected=202/);
});
