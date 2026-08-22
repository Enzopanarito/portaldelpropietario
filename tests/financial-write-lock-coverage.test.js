'use strict';
const assert=require('assert');

process.env.ADMIN_TOKEN_SECRET='test-secret-independent-from-password';
process.env.ADMIN_PASSWORD='test-password';
process.env.AIRTABLE_API_TOKEN='pat_test_only';
process.env.AIRTABLE_BASE_ID='appTestBase000001';

let unexpected=[];
const staleCreatedTime=new Date(Date.now()-72*60*60*1000).toISOString();
global.fetch=async (input,init={})=>{
  const url=String(input&&input.url||input||'');
  const method=String(init.method||'GET').toUpperCase();
  if(url.includes('/ControlVersiones')){
    if(method==='GET'&&url.includes('API_USAGE_DAILY'))return new Response(JSON.stringify({records:[]}),{status:200,headers:{'content-type':'application/json'}});
    if(method==='GET')return new Response(JSON.stringify({records:[{id:'recLock0000000001',createdTime:staleCreatedTime,fields:{Key:'MONTHLY_CLOSE|2026-07|LOCKED|test-lock',Version:1}}]}),{status:200,headers:{'content-type':'application/json'}});
    if(method==='PATCH')return new Response(JSON.stringify({records:[{id:'recUsage000000001',fields:{Key:'API_USAGE_DAILY|2026-07-13',Version:3}}]}),{status:200,headers:{'content-type':'application/json'}});
  }
  unexpected.push({url,method});
  return new Response(JSON.stringify({message:'Unexpected business request in lock test'}),{status:500,headers:{'content-type':'application/json'}});
};

const {issueAdminToken}=require('../netlify/functions/_shared/_auth');
const manual=require('../netlify/functions/admin-manual-payment').handler;
const report=require('../netlify/functions/process-payment-report').handler;
const token=issueAdminToken({authVersion:0});
const baseEvent={httpMethod:'POST',headers:{authorization:`Bearer ${token}`}};

(async()=>{
  const manualResponse=await manual({...baseEvent,body:JSON.stringify({ownerId:'rec12345678901234',mode:'USD',amount:10,reference:'LOCK-TEST',operationId:'lock-test-payment'})});
  assert.strictEqual(manualResponse.statusCode,423,'El pago manual debe quedar bloqueado incluso con un lock de 72 horas.');
  const manualBody=JSON.parse(manualResponse.body);
  assert.strictEqual(manualBody.closeInProgress,true);
  assert.strictEqual(manualBody.staleLock,true,'Un lock mayor de 24h debe señalarse como stale, no ignorarse.');
  assert.strictEqual(manualBody.requiresRecovery,true,'Un lock stale debe exigir recuperación explícita.');

  const reportResponse=await report({...baseEvent,body:JSON.stringify({reportId:'rec12345678901234',decision:'approve'})});
  assert.strictEqual(reportResponse.statusCode,423,'La aprobación de reportes debe quedar bloqueada incluso con un lock stale.');
  const reportBody=JSON.parse(reportResponse.body);
  assert.strictEqual(reportBody.closeInProgress,true);
  assert.strictEqual(reportBody.staleLock,true);
  assert.strictEqual(reportBody.requiresRecovery,true);

  assert.deepStrictEqual(unexpected,[],'Ninguna lectura o escritura financiera debe ocurrir después de detectar el bloqueo stale.');
  console.log('FINANCIAL_WRITE_STALE_LOCK_FAIL_CLOSED_OK');
})().catch(error=>{console.error(error);process.exit(1)});
