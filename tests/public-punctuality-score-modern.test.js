'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

const OWNER_ID='recABCDEFGHIJKLMN';

async function moduleUnderTest(){return import('../netlify/functions/public-punctuality-score-modern.mjs')}

test('la ruta moderna reconoce solo contextos no productivos autorizados',async()=>{
  const {isFixtureContext}=await moduleUnderTest();
  assert.equal(isFixtureContext({deploy:{context:'deploy-preview'}}),true);
  assert.equal(isFixtureContext({deploy:{context:'branch-deploy'}}),true);
  assert.equal(isFixtureContext({deploy:{context:'production'}}),false);
  assert.equal(isFixtureContext({}),false);
  assert.equal(isFixtureContext({},new Request('https://deploy-preview-246--villalosapamates.netlify.app/api/vla/punctuality-score')),true);
  assert.equal(isFixtureContext({},new Request('https://villalosapamates.netlify.app/api/vla/punctuality-score')),false);
  assert.equal(isFixtureContext({},new Request('https://villalosapamates.com/api/vla/punctuality-score')),false);
});

test('Deploy Preview obtiene fixture read-only sin depender de CONTEXT ni Airtable',async()=>{
  const mod=await moduleUnderTest();
  const request=new Request(`https://deploy-preview-221--villalosapamates.netlify.app/api/vla/punctuality-score?ownerId=${OWNER_ID}`);
  const response=await mod.default(request,{deploy:{context:'deploy-preview'}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-punctuality-source'),'PREVIEW_FIXTURE');
  assert.equal(body.preview,true);
  assert.equal(body.readOnly,true);
  assert.equal(body.score,92);
});

test('Deploy Preview conserva fixture aunque Netlify no entregue deploy.context',async()=>{
  const mod=await moduleUnderTest();
  const request=new Request(`https://deploy-preview-246--villalosapamates.netlify.app/api/vla/punctuality-score?ownerId=${OWNER_ID}`);
  const response=await mod.default(request,{});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-punctuality-source'),'PREVIEW_FIXTURE');
  assert.equal(body.preview,true);
  assert.equal(body.readOnly,true);
  assert.equal(body.score,92);
});

test('Branch Deploy también queda aislado del libro productivo',async()=>{
  const mod=await moduleUnderTest();
  const request=new Request(`https://preview-alias.netlify.app/api/vla/punctuality-score?ownerId=${OWNER_ID}`);
  const response=await mod.default(request,{deploy:{context:'branch-deploy'}});
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('x-punctuality-source'),'PREVIEW_FIXTURE');
  assert.equal(body.preview,true);
});

test('la configuración pública apunta al endpoint moderno esperado',async()=>{
  const mod=await moduleUnderTest();
  assert.equal(mod.config.path,'/api/vla/punctuality-score');
});
