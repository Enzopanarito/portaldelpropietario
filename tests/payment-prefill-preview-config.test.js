'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const prefill=require('../netlify/functions/payment-proof-prefill');

function unavailable(){return Promise.reject(new Error('staging config unavailable'))}

test('fallback técnico solo se permite en contextos Netlify no productivos',()=>{
 assert.equal(prefill.previewConfigAllowed({CONTEXT:'deploy-preview'}),true);
 assert.equal(prefill.previewConfigAllowed({CONTEXT:'branch-deploy',VLA_DATA_ENVIRONMENT:'staging'}),true);
 assert.equal(prefill.previewConfigAllowed({CONTEXT:'dev'}),true);
 assert.equal(prefill.previewConfigAllowed({CONTEXT:'production'}),false);
 assert.equal(prefill.previewConfigAllowed({CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'production'}),false);
 assert.equal(prefill.previewConfigAllowed({}),false);
});

test('preview puede probar Gemini sin depender de Configuración Airtable staging',async()=>{
 const config=await prefill.loadAiConfig({env:{CONTEXT:'deploy-preview'},listConfig:unavailable});
 assert.equal(config.aiEnabled,true);
 assert.equal(config.primaryModel,'gemini-3.6-flash');
 assert.equal(config.secondaryModel,'gemini-3.5-flash');
 assert.equal(config.automaticApprovalEnabled,false);
 assert.equal(config.minimumAutomaticConfidence,1);
});

test('producción sigue fail-closed si Configuración Airtable no está disponible',async()=>{
 await assert.rejects(
  ()=>prefill.loadAiConfig({env:{CONTEXT:'production',VLA_DATA_ENVIRONMENT:'production'},listConfig:unavailable}),
  error=>error?.code==='PREFILL_CONFIG_UNAVAILABLE'
 );
});
