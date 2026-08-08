'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

async function load(name){return import(`../netlify/functions/${name}-modern.mjs?test=${Date.now()}-${Math.random()}`)}

test('la ruta pública delega en Lambda nativa y conserva el query string',async()=>{
  const route=await load('public-data'),originalFetch=global.fetch;
  let received=null;
  try{
    global.fetch=async request=>{received=request;return new Response('{}',{status:200,headers:{'x-public-snapshot':'HIT'}})};
    const response=await route.default(new Request('https://villalosapamates.netlify.app/api/vla/public-data?force=1'));
    assert.equal(received.url,'https://villalosapamates.netlify.app/.netlify/functions/public-data-v3?force=1');
    assert.equal(received.method,'GET');
    assert.equal(response.headers.get('x-public-snapshot'),'HIT');
  }finally{global.fetch=originalFetch}
});

test('el reporte conserva el JSON completo al entrar en Lambda nativa',async()=>{
  const route=await load('public-report-payment'),originalFetch=global.fetch;
  let received=null;
  try{
    global.fetch=async request=>{received=request;return new Response('{"success":true}',{status:200,headers:{'content-type':'application/json'}})};
    const payload=JSON.stringify({submissionId:'submission-test-001',attachment:{name:'proof.png',base64:'AA=='}});
    const response=await route.default(new Request('https://villalosapamates.netlify.app/api/vla/report-payment',{method:'POST',headers:{'content-type':'application/json','x-test-header':'kept'},body:payload}));
    assert.equal(received.url,'https://villalosapamates.netlify.app/.netlify/functions/public-report-payment');
    assert.equal(received.method,'POST');
    assert.equal(received.headers.get('content-type'),'application/json');
    assert.equal(received.headers.get('x-test-header'),'kept');
    assert.equal(await received.text(),payload);
    assert.equal(await response.json().then(value=>value.success),true);
  }finally{global.fetch=originalFetch}
});
