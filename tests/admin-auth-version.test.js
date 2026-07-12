'use strict';
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');

function token(version){
  const claims={iss:'villa-los-apamates',aud:'vla-admin',role:'admin',authVersion:version,exp:Date.now()+60000};
  return Buffer.from(JSON.stringify(claims)).toString('base64url')+'.test-signature';
}
async function load(currentVersion){
  const source=fs.readFileSync('netlify/edge-functions/admin-auth-version.js','utf8').replace('export default async','module.exports = async');
  let airtableCalls=0;
  const context={module:{exports:{}},exports:{},console,URL,Response,Headers,Request,Buffer,setTimeout,clearTimeout,atob:value=>Buffer.from(value,'base64').toString('binary'),fetch:async()=>{airtableCalls++;return new Response(JSON.stringify({records:currentVersion===null?[]:[{fields:{Version:currentVersion}}]}),{status:200,headers:{'content-type':'application/json'}})},Netlify:{env:{get:name=>name==='AIRTABLE_API_TOKEN'?'pat_test':name==='AIRTABLE_BASE_ID'?'appTestBase000001':undefined}}};
  vm.runInNewContext(source,context,{filename:'admin-auth-version.js'});
  return{handler:context.module.exports,calls:()=>airtableCalls};
}
(async()=>{
  {
    const runtime=await load(3);
    const request=new Request('https://example.test/.netlify/functions/admin-data',{headers:{authorization:`Bearer ${token(2)}`}});
    const response=await runtime.handler(request,{next:async()=>new Response('downstream',{status:200})});
    assert.strictEqual(response.status,401);
    assert.strictEqual((await response.json()).sessionRevoked,true);
  }
  {
    const runtime=await load(3);
    const request=new Request('https://example.test/.netlify/functions/admin-data',{headers:{authorization:`Bearer ${token(3)}`}});
    const response=await runtime.handler(request,{next:async()=>new Response('ok',{status:200})});
    assert.strictEqual(response.status,200);
    assert.strictEqual(response.headers.get('x-vla-auth-version'),'3');
  }
  {
    const runtime=await load(3);
    const request=new Request('https://example.test/.netlify/functions/bcv-rate');
    const response=await runtime.handler(request,{next:async()=>new Response('public',{status:200})});
    assert.strictEqual(response.status,200);
    assert.strictEqual(runtime.calls(),0,'Los endpoints públicos no deben consultar Airtable para validar sesión.');
  }
  console.log('ADMIN_AUTH_VERSION_EDGE_OK');
})().catch(error=>{console.error(error);process.exit(1)});
