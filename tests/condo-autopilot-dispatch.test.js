'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {verify}=require('../netlify/functions/_internal_job_auth');

test('el cron solo despacha y firma el trabajo pesado de forma interna',async()=>{
 const previous={URL:process.env.URL,AUTOMATION_JOB_SECRET:process.env.AUTOMATION_JOB_SECRET,fetch:global.fetch};
 process.env.URL='https://villa.test';
 process.env.AUTOMATION_JOB_SECRET='secret-for-dispatch-test';
 let request=null;
 global.fetch=async(url,options)=>{request={url,options};return{ok:true,status:202}};
 try{
  delete require.cache[require.resolve('../netlify/functions/condo-autopilot-scheduled')];
  const result=await require('../netlify/functions/condo-autopilot-scheduled').handler();
  const body=JSON.parse(result.body);
  assert.equal(result.statusCode,202);
  assert.equal(body.queued,true);
  assert.equal(request.url,'https://villa.test/api/vla/condo-autopilot');
  assert.equal(verify(request.options.body,request.options.headers,process.env),true);
 }finally{
  global.fetch=previous.fetch;
  if(previous.URL===undefined)delete process.env.URL;else process.env.URL=previous.URL;
  if(previous.AUTOMATION_JOB_SECRET===undefined)delete process.env.AUTOMATION_JOB_SECRET;else process.env.AUTOMATION_JOB_SECRET=previous.AUTOMATION_JOB_SECRET;
 }
});

test('el trabajo pesado rechaza invocaciones externas sin firma',async()=>{
 const result=await require('../netlify/functions/condo-autopilot-background').handler({body:'{}',headers:{}});
 assert.equal(result.statusCode,401);
 assert.match(JSON.parse(result.body).message,/no autorizado/i);
});
