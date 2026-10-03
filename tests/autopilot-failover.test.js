'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const oidc=require('../netlify/functions/_shared/_github_oidc_autopilot');
const failover=require('../netlify/functions/autopilot-failover-ci');

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
   run_id:'123456',
   iat:now-30,
   nbf:now-30,
   exp:now+300,
   ...overrides
  }
 };
}

test('la identidad OIDC del failover queda amarrada a repo, workflow, main y eventos permitidos',()=>{
 const {claims,now}=validClaims();
 assert.equal(oidc.validateClaims(claims,now).run_id,'123456');
 for(const [field,value,code] of [
  ['aud','otro-audience','OIDC_AUDIENCE_INVALID'],
  ['repository','otro/repo','OIDC_REPOSITORY_INVALID'],
  ['workflow','Otro Workflow','OIDC_WORKFLOW_INVALID'],
  ['ref','refs/heads/feature','OIDC_REF_INVALID'],
  ['event_name','pull_request','OIDC_EVENT_INVALID']
 ]){
  const altered={...claims,[field]:value};
  assert.throws(()=>oidc.validateClaims(altered,now),new RegExp(code));
 }
});

test('la ventana de rescate solo permite días 1 al 3 de Caracas',()=>{
 for(const day of [1,2,3])assert.equal(failover.isRecoveryWindow({day}),true);
 for(const day of [0,4,15,31])assert.equal(failover.isRecoveryWindow({day}),false);
});

test('el endpoint failover usa OIDC, firma interna y cola el piloto canónico sin duplicar lógica financiera',()=>{
 const source=read('netlify/functions/autopilot-failover-ci.js');
 assert.match(source,/verifyAutopilotFailoverOidcToken/);
 assert.match(source,/isRecoveryWindow/);
 assert.match(source,/sign\(payload\)/);
 assert.match(source,/\/api\/vla\/condo-autopilot/);
 assert.match(source,/github-oidc-autopilot-failover/);
 assert.doesNotMatch(source,/monthly-close/);
 assert.doesNotMatch(source,/AIRTABLE_API_TOKEN/);
});

test('el workflow externo corre después del cron Netlify y el manual queda en probe por defecto',()=>{
 const source=read('.github/workflows/autopilot-failover.yml');
 assert.match(source,/cron: '12 4 1-3 \* \*'/);
 assert.match(source,/audience=vla-autopilot-failover/);
 assert.match(source,/default: probe/);
 assert.match(source,/if \[ "\$\{\{ github\.event_name \}\}" = "schedule" \]; then\s+mode=dispatch/);
 assert.match(source,/expected=200; else expected=202/);
 assert.match(source,/id-token: write/);
});

test('el respaldo normaliza la URL HTTP de Netlify antes de despachar el POST firmado',async()=>{
 const vm=require('node:vm');
 const module={exports:{}};
 let request;
 const FixedDate=class extends Date { constructor(...args){super(...(args.length?args:['2026-10-01T04:12:00Z']))} };
 const context={
  module,exports:module.exports,Date:FixedDate,Intl,URL,console,
  process:{env:{URL:'http://villalosapamates.netlify.app'}},
  require(name){
   if(name.includes('_github_oidc_autopilot'))return{verifyAutopilotFailoverOidcToken:async()=>({run_id:'test'})};
   if(name.includes('_internal_job_auth'))return{sign:()=>({timestamp:'test-time',signature:'test-signature'})};
   if(name.includes('_internal_site_url'))return require('../netlify/functions/_shared/_internal_site_url');
   throw new Error(`Unexpected dependency: ${name}`);
  },
  fetch:async(url,options)=>{request={url,options};return{ok:true,status:202}}
 };
 vm.runInNewContext(read('netlify/functions/autopilot-failover-ci.js'),context);
 const result=await module.exports.handler({httpMethod:'POST',body:JSON.stringify({oidcToken:'test',mode:'dispatch'})});
 assert.equal(result.statusCode,202);
 assert.equal(request.url,'https://villalosapamates.netlify.app/api/vla/condo-autopilot');
 assert.equal(request.options.method,'POST');
 assert.equal(request.options.headers['x-vla-job-signature'],'test-signature');
 assert.equal(JSON.parse(request.options.body).source,'github-oidc-autopilot-failover');
});
