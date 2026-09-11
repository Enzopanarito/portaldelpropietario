'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const store=require('../netlify/functions/_shared/_communications_store');

test('aviso moderno usa el endpoint fuerte real del SDK sin modificar el contexto ni credenciales',async()=>{
 const oldContext=globalThis.netlifyBlobsContext,oldFetch=global.fetch;
 const context=Buffer.from(JSON.stringify({siteID:'fixture-site',token:'fixture-token',edgeURL:'https://cached.example.invalid',uncachedEdgeURL:'https://strong.example.invalid'})).toString('base64');
 globalThis.netlifyBlobsContext=context;
 const requests=[];
 global.fetch=async(url,options)=>{requests.push({url:String(url),method:options?.method});return new Response(null,{status:404})};
 try{
  const handler=(await import('../netlify/functions/public-notice.mjs')).default;
  const response=await handler(new Request('https://vla.example.invalid/api/vla/public-notice'),{});
  assert.equal(response.headers.get('X-VLA-Notice-Storage'),'strong-read-ok');
  assert.deepEqual(await response.json(),{notice:null});
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/^https:\/\/strong\.example\.invalid\/fixture-site\//);
  assert.equal(globalThis.netlifyBlobsContext,context);
  await store.recentJobs();
  assert.equal(requests.length,2);
  assert.ok(requests.every(x=>x.url.startsWith('https://strong.example.invalid/')));
 }finally{global.fetch=oldFetch;if(oldContext===undefined)delete globalThis.netlifyBlobsContext;else globalThis.netlifyBlobsContext=oldContext}
});

test('las tres funciones conservan sus nombres públicos y usan el runtime moderno',()=>{
 for(const name of ['admin-communications','public-notice','communications-dispatch-background']){
  assert.equal(fs.existsSync(`netlify/functions/${name}.js`),false);
  assert.match(fs.readFileSync(`netlify/functions/${name}.mjs`,'utf8'),/export default.*invokeLegacy/);
 }
});
