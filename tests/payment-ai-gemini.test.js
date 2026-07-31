'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const gemini=require('../netlify/functions/_payment_ai_gemini');

(async()=>{
 assert.strictEqual(gemini.safeModel('gemini-2.5-flash'),'gemini-2.5-flash');
 assert.throws(()=>gemini.safeModel('bad/model?key=secret'),error=>error.code==='AI_MODEL_INVALID');
 const calls=[];
 const runner=gemini.createGeminiAnalysisRunner({
  apiKey:'test-secret',
  fetchFn:async(url,options)=>{calls.push({url,options});return{ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'{"method":"ZELLE"}'}]}}]})}}
 });
 const raw=await runner({model:'gemini-2.5-flash',proof:{content:Buffer.from('proof'),contentType:'image/png'},report:{fields:{'Forma de Pago Reportada':'USD'}},promptVersion:'PROMPT'});
 assert.strictEqual(raw,'{"method":"ZELLE"}');
 assert(!calls[0].url.includes('test-secret'));
 assert.strictEqual(calls[0].options.headers['x-goog-api-key'],'test-secret');
 const body=JSON.parse(calls[0].options.body);
 assert.strictEqual(body.contents[0].parts[1].inlineData.mimeType,'image/png');
 assert.strictEqual(body.generationConfig.responseMimeType,'application/json');
 const endpoint=fs.readFileSync(path.join(__dirname,'..','netlify','functions','gemini.js'),'utf8');
 assert(!/console\.(log|error).*GEMINI|\\?key=|gemini-pro:generateContent/.test(endpoint));
 console.log('PAYMENT_AI_GEMINI_OK');
})().catch(error=>{console.error(error);process.exit(1)});
