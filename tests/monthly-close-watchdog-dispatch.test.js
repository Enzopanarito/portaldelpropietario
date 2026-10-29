'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const autopilot=require('../netlify/functions/condo-autopilot-background');
const watchdog=require('../netlify/functions/monthly-close-watchdog-scheduled');
const {verify}=require('../netlify/functions/_shared/_internal_job_auth');
test('el recuperador moderno despacha al background sin ejecutar el cierre dentro del cron',async()=>{
 const previous={fetch:global.fetch,handler:autopilot.handler,env:{...process.env}};
 process.env.AIRTABLE_API_TOKEN='audit-test';process.env.AIRTABLE_BASE_ID='appTest';process.env.AUTOMATION_JOB_SECRET='watchdog-dispatch-test';process.env.URL='http://villalosapamates.netlify.app';
 let inlineCalls=0,queued=null;
 autopilot.handler=async()=>{inlineCalls++;throw Error('El cron no debe ejecutar el cierre completo')};
 global.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.airtable.com/'))return{ok:true,json:async()=>({records:[]})};
  queued={url,options};return{ok:true,status:202};
 };
 try{
  const result=await watchdog.handler({__netlifyModernRuntime:true});
  assert.equal(result.statusCode,202);
  assert.equal(JSON.parse(result.body).queued,true);
  assert.equal(inlineCalls,0);
  assert.equal(queued.url,'https://villalosapamates.netlify.app/api/vla/condo-autopilot');
  assert.equal(verify(queued.options.body,queued.options.headers),true);
  assert.equal(JSON.parse(queued.options.body).source,'monthly-close-watchdog');
 }finally{
  global.fetch=previous.fetch;autopilot.handler=previous.handler;
  for(const k of ['AIRTABLE_API_TOKEN','AIRTABLE_BASE_ID','AUTOMATION_JOB_SECRET','URL']){if(previous.env[k]===undefined)delete process.env[k];else process.env[k]=previous.env[k]}
 }
});
