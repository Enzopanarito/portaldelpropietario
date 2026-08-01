'use strict';

const assert=require('assert');
const visual=require('../netlify/functions/_payment_visual_hash');
const duplicate=require('../netlify/functions/_payment_duplicate_core');

(async()=>{
 const content=Buffer.from('fake-image');
 const gradient=Buffer.from(Array.from({length:72},(_,index)=>index));
 const factory=async()=>({rotate(){return this},resize(){return this},grayscale(){return this},removeAlpha(){return this},raw(){return this},async toBuffer(){return{data:gradient,info:{width:9,height:8,channels:1}}}});
 const result=await visual.computePerceptualHash(content,'image/png',{sharpFactory:factory});
 assert.strictEqual(result.supported,true);assert.match(result.hash,/^[a-f0-9]{16}$/);assert.strictEqual(result.algorithm,'dhash-64-v1');
 const repeated=await visual.computePerceptualHash(content,'image/png',{sharpFactory:factory});assert.strictEqual(repeated.hash,result.hash);
 assert.strictEqual(duplicate.hammingDistance(result.hash,repeated.hash),0);
 const pdf=await visual.computePerceptualHash(content,'application/pdf',{sharpFactory:async()=>{throw new Error('no debe ejecutarse')}});assert.strictEqual(pdf.supported,false);assert.strictEqual(pdf.hash,'');
 await assert.rejects(()=>visual.computePerceptualHash(Buffer.alloc(0),'image/png',{sharpFactory:factory}),error=>error.code==='VISUAL_HASH_EMPTY');
 await assert.rejects(()=>visual.computePerceptualHash(content,'image/png',{sharpFactory:async()=>{throw new Error('decoder')}}),error=>error.code==='VISUAL_HASH_FAILED');
 console.log('PAYMENT_VISUAL_HASH_OK');
})().catch(error=>{console.error(error);process.exit(1)});
