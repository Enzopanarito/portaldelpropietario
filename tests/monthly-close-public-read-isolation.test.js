'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {handler}=require('../netlify/functions/public-data-v4');
const RealDate=Date;
const marker=status=>({id:'close-marker',fields:{Key:`MONTHLY_CLOSE|2026-10|${status}|audit-test-op`}});
async function readDuringClose(initial,final=initial){
 const previous={fetch:global.fetch,Date:global.Date,token:process.env.AIRTABLE_API_TOKEN,base:process.env.AIRTABLE_BASE_ID};
 global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-01T04:01:00Z']))}static now(){return new RealDate('2026-11-01T04:01:00Z').getTime()}};
 process.env.AIRTABLE_API_TOKEN='test-only';process.env.AIRTABLE_BASE_ID='audit-base';let markerReads=0;
 global.fetch=async(url,options={})=>{
  assert.equal(options.method||'GET','GET');
  const u=new URL(url),table=decodeURIComponent(u.pathname.split('/')[3]);let records=[];
  if(table==='ControlVersiones'&&u.searchParams.get('filterByFormula')?.includes('MONTHLY_CLOSE|')){records=markerReads++?final:initial}
  if(table==='Propietarios')records=Array.from({length:15},(_,i)=>({id:`owner-${i+1}`,fields:{Casa:i+1,Propietario:`Casa ${i+1}`,Alicuota:1/15,'Deuda Anterior USD':i===0?-10:0,'Deuda Anterior Bs Ref':0,'Deuda Anterior':i===0?-10:0}}));
  return{ok:true,json:async()=>({records})};
 };
 try{const result=await handler({httpMethod:'GET',queryStringParameters:{force:'1'}});return{...result,payload:JSON.parse(result.body),markerReads}}
 finally{global.fetch=previous.fetch;global.Date=previous.Date;for(const [key,value]of [['AIRTABLE_API_TOKEN',previous.token],['AIRTABLE_BASE_ID',previous.base]]){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}
for(const state of ['LOCKED','ERROR_PARTIAL'])test(`no publica saldos calculados durante un cierre ${state}`,async()=>{
 const result=await readDuringClose([marker(state)]);
 assert.equal(result.statusCode,503);
 assert.equal(result.payload.code,'ACCOUNTING_CLOSE_IN_PROGRESS');
 assert.equal(result.payload.propietarios,undefined);
});
test('descarta una lectura si el cierre cambia mientras se consultan propietarios y pagos',async()=>{
 const result=await readDuringClose([], [marker('DONE')]);
 assert.equal(result.statusCode,503);
 assert.equal(result.payload.code,'ACCOUNTING_TRANSITION_CHANGED');
 assert.equal(result.payload.propietarios,undefined);
});
test('un cierre DONE estable permite publicar los saldos del nuevo mes',async()=>{
 const result=await readDuringClose([marker('DONE')]);
 assert.equal(result.statusCode,200);
 assert.equal(result.payload.accountingTransition.accountingMonth,'2026-11');
 assert.equal(result.payload.propietarios.length,15);
 assert.equal(result.markerReads,2);
});
