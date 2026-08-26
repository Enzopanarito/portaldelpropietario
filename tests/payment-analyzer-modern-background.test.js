'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const {pathToFileURL}=require('url');

const root=path.join(__dirname,'..');
const modernPath=path.join(root,'netlify','functions','payment-report-analyzer-modern-background.mjs');
const tomlPath=path.join(root,'netlify.toml');
const bridgePath=path.join(root,'netlify','functions','_shared','legacy-function-bridge.mjs');

test('el analizador de pagos usa Background Function moderna y no redirect Lambda v1',()=>{
 const modern=fs.readFileSync(modernPath,'utf8'),toml=fs.readFileSync(tomlPath,'utf8');
 assert.match(modern,/payment-report-analyzer-background\.js/);
 assert.match(modern,/path:'\/api\/vla\/payment-report-analyzer'/);
 assert.match(modern,/method:'POST'/);
 assert.match(modern,/background:true/);
 assert.doesNotMatch(toml,/from\s*=\s*"\/api\/vla\/payment-report-analyzer"[\s\S]{0,180}payment-report-analyzer-background/);
});

test('el bridge moderno marca el evento y conserva autenticación interna',async()=>{
 const bridge=await import(pathToFileURL(bridgePath).href);
 for(let i=0;i<100;i++){
  const request=new Request('https://example.test/api/vla/payment-report-analyzer',{method:'POST',headers:{'content-type':'application/json','x-vla-job-timestamp':'1234567890','x-vla-job-signature':'firma-prueba'},body:JSON.stringify({reportId:'recABCDEF12345678'})});
  const event=await bridge.toLegacyEvent(request);
  assert.equal(event.__netlifyModernRuntime,true);
  assert.equal(event.httpMethod,'POST');
  assert.equal(event.path,'/api/vla/payment-report-analyzer');
  assert.equal(event.headers['x-vla-job-timestamp'],'1234567890');
  assert.equal(event.headers['x-vla-job-signature'],'firma-prueba');
  assert.equal(JSON.parse(event.body).reportId,'recABCDEF12345678');
 }
});
