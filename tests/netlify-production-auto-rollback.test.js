'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

const root=path.join(__dirname,'..');
const modulePromise=import(pathToFileURL(path.join(root,'scripts','vla-netlify-auto-rollback.mjs')).href);
const did=n=>n.toString(16).padStart(24,'0').slice(-24);
const sha=n=>n.toString(16).padStart(40,'0').slice(-40);
const iso=n=>new Date(Date.UTC(2026,7,18,20,0,n)).toISOString();
const res=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});

function makeDeploy({id,siteId,commit,created,state='ready',context='production',draft=false}){
  return{id,site_id:siteId,state,context,draft,commit_ref:commit,title:`VLA production commit=${commit}`,created_at:created,published_at:created,deploy_ssl_url:`https://${id}--villalosapamates.netlify.app`};
}
function mockApi({siteId,current,deploys,restoreStatus=201}){
  let published=current.id;
  const byId=new Map(deploys.map(d=>[d.id,d]));
  const calls=[];
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url);calls.push({url,method:init.method||'GET'});
    if(u.pathname===`/api/v1/sites/${siteId}`)return res(200,{id:siteId,published_deploy:{id:published}});
    if(u.pathname===`/api/v1/sites/${siteId}/deploys`){return res(200,deploys);}
    const restore=u.pathname.match(new RegExp(`^/api/v1/sites/${siteId}/deploys/([0-9a-f]{24})/restore$`));
    if(restore){if(restoreStatus!==201)return res(restoreStatus,{message:'restore failed'});published=restore[1];return res(201,byId.get(published));}
    const one=u.pathname.match(new RegExp(`^/api/v1/sites/${siteId}/deploys/([0-9a-f]{24})$`));
    if(one){const d=byId.get(one[1]);return d?res(200,d):res(404,{message:'missing'});}
    return res(404,{message:'unknown'});
  };
  return{fetchImpl,calls,published:()=>published};
}

test('100 veces: un deploy fallido vivo vuelve exactamente al predecesor bueno',async()=>{
  const m=await modulePromise;
  for(let i=1;i<=100;i++){
    const siteId=`site-${i}`,failedSha=sha(10000+i),goodSha=sha(5000+i),olderSha=sha(1000+i);
    const current=makeDeploy({id:did(9000+i),siteId,commit:failedSha,created:iso(50)});
    const sameShaOlder=makeDeploy({id:did(8000+i),siteId,commit:failedSha,created:iso(45)});
    const good=makeDeploy({id:did(7000+i),siteId,commit:goodSha,created:iso(40)});
    const older=makeDeploy({id:did(6000+i),siteId,commit:olderSha,created:iso(30)});
    const mock=mockApi({siteId,current,deploys:[current,sameShaOlder,good,older]});
    const out=await m.rollbackFailedProduction({token:'token',siteId,failedSha,failedWorkflow:'Deploy Netlify Production',apiBase:'https://mock/api/v1',fetchImpl:mock.fetchImpl,sleep:async()=>{},pollDelayMs:0,pollAttempts:3});
    assert.equal(out.action,'restored',`iteración ${i}`);
    assert.equal(out.failedDeployId,current.id,`iteración ${i}`);
    assert.equal(out.restoredDeployId,good.id,`iteración ${i}`);
    assert.equal(mock.published(),good.id,`iteración ${i}`);
    const posts=mock.calls.filter(c=>c.method==='POST');
    assert.equal(posts.length,1,`iteración ${i}`);
    assert.match(posts[0].url,new RegExp(`${good.id}/restore$`),`iteración ${i}`);
  }
});

test('si el workflow falla antes de publicar, no toca producción',async()=>{
  const m=await modulePromise,siteId='predeploy-fail',failedSha=sha(201),goodSha=sha(200);
  const current=makeDeploy({id:did(201),siteId,commit:goodSha,created:iso(40)});
  const mock=mockApi({siteId,current,deploys:[current]});
  const out=await m.rollbackFailedProduction({token:'x',siteId,failedSha,failedWorkflow:'Deploy Netlify Production',apiBase:'https://mock/api/v1',fetchImpl:mock.fetchImpl});
  assert.equal(out.action,'noop');assert.equal(out.reason,'CURRENT_DEPLOY_IS_NOT_FAILED_SHA');assert.equal(mock.calls.filter(c=>c.method==='POST').length,0);
});

test('un segundo watchdog después de restaurar es idempotente y no restaura otra vez',async()=>{
  const m=await modulePromise,siteId='repeat',failedSha=sha(301),goodSha=sha(300);
  const current=makeDeploy({id:did(301),siteId,commit:goodSha,created:iso(40)});
  const mock=mockApi({siteId,current,deploys:[current]});
  const out=await m.rollbackFailedProduction({token:'x',siteId,failedSha,failedWorkflow:'Deploy Netlify Production',apiBase:'https://mock/api/v1',fetchImpl:mock.fetchImpl});
  assert.equal(out.action,'noop');assert.equal(mock.calls.filter(c=>c.method==='POST').length,0);
});

test('salta deploys anteriores del mismo commit fallido y escoge el anterior distinto',async()=>{
  const m=await modulePromise,siteId='same-sha',failedSha=sha(401),goodSha=sha(400);
  const current=makeDeploy({id:did(404),siteId,commit:failedSha,created:iso(50)});
  const duplicate=makeDeploy({id:did(403),siteId,commit:failedSha,created:iso(49)});
  const good=makeDeploy({id:did(402),siteId,commit:goodSha,created:iso(48)});
  const selected=m.selectPreviousProductionDeploy({deploys:[current,duplicate,good],currentDeploy:current,failedSha});
  assert.equal(selected.id,good.id);
});

test('un restore HTTP fallido nunca se reporta como éxito',async()=>{
  const m=await modulePromise,siteId='restore-http',failedSha=sha(501),goodSha=sha(500);
  const current=makeDeploy({id:did(501),siteId,commit:failedSha,created:iso(50)}),good=makeDeploy({id:did(500),siteId,commit:goodSha,created:iso(40)});
  const mock=mockApi({siteId,current,deploys:[current,good],restoreStatus:500});
  await assert.rejects(()=>m.rollbackFailedProduction({token:'x',siteId,failedSha,failedWorkflow:'Deploy Netlify Production',apiBase:'https://mock/api/v1',fetchImpl:mock.fetchImpl}),/RESTORE_HTTP_500/);
});

test('sin predecesor seguro falla cerrado en vez de inventarlo',async()=>{
  const m=await modulePromise,siteId='none',failedSha=sha(601);
  const current=makeDeploy({id:did(601),siteId,commit:failedSha,created:iso(50)});
  const mock=mockApi({siteId,current,deploys:[current]});
  await assert.rejects(()=>m.rollbackFailedProduction({token:'x',siteId,failedSha,failedWorkflow:'Deploy Netlify Production',apiBase:'https://mock/api/v1',fetchImpl:mock.fetchImpl}),/PREVIOUS_PRODUCTION_DEPLOY_NOT_FOUND/);
});

test('el workflow solo escucha Deploy Netlify Production fallido y verifica release + 150 campos',()=>{
  const wf=fs.readFileSync(path.join(root,'.github','workflows','netlify-production-auto-rollback.yml'),'utf8');
  assert.match(wf,/workflows: \["Deploy Netlify Production"\]/);
  assert.match(wf,/github\.event\.workflow_run\.conclusion != 'success'/);
  assert.match(wf,/concurrency:\s*\n\s*group: vla-production-auto-rollback/);
  assert.match(wf,/scripts\/vla-netlify-auto-rollback\.mjs/);
  assert.match(wf,/Verify restored release and 150 financial fields/);
  assert.match(wf,/ROLLBACK_FINANCIAL_BASELINE_OK 15\/15 houses · 150\/150 fields/);
  assert.doesNotMatch(wf,/workflow_dispatch/);
});
