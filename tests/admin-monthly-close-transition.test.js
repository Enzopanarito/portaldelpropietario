'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {issueAdminToken}=require('../netlify/functions/_shared/_auth');
const {handler}=require('../netlify/functions/admin-data-v3');
const RealDate=Date;
const marker=status=>({id:'marker',fields:{Key:`MONTHLY_CLOSE|2026-10|${status}|op`}});
async function read(initial=[],final=initial,done=false){
 const previous={fetch:global.fetch,Date:global.Date,env:{...process.env}};
 global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-11-01T04:01:00Z']))}static now(){return new RealDate('2026-11-01T04:01:00Z').getTime()}};
 Object.assign(process.env,{AIRTABLE_API_TOKEN:'test',AIRTABLE_BASE_ID:'test',ADMIN_TOKEN_SECRET:'test-only-admin-secret-of-at-least-32-characters'});
 let reads=0;
 const owners=Array.from({length:15},(_,i)=>({id:`owner-${i+1}`,fields:{Casa:i+1,Alicuota:1/15,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}}));
 global.fetch=async(url,opts={})=>{
  assert.equal(opts.method||'GET','GET');
  const u=new URL(url),table=decodeURIComponent(u.pathname.split('/')[3]);let records=[];
  if(table==='ControlVersiones'&&u.searchParams.get('filterByFormula')?.includes('MONTHLY_CLOSE|'))records=reads++?final:initial;
  if(table==='Propietarios')records=owners;
  if(table==='Gastos del Mes')records=[
   {id:'oct-expense',fields:{Concepto:'Octubre',Monto:150,'Tipo de Gasto':'Gasto Común','Forma de Pago':'USD','Mes de Aplicación':'2026-10','Estado del Gasto':done?'Cerrado':'Activo'}},
   {id:'nov-expense',fields:{Concepto:'Noviembre',Monto:300,'Tipo de Gasto':'Gasto Común','Forma de Pago':'USD','Mes de Aplicación':'2026-11','Estado del Gasto':done?'Activo':'Programado'}}
  ];
  if(table==='Pagos')records=owners.map((o,i)=>({id:`payment-${i}`,fields:{'Propietario que Paga':[o.id],'Fecha de Pago':'2026-10-10','Monto Pagado':10,'Forma de Pago':'USD','[x] Aplicado al Cierre':done}}));
  return{ok:true,json:async()=>({records})};
 };
 try{
  const result=await handler({httpMethod:'GET',headers:{authorization:`Bearer ${issueAdminToken({authVersion:0})}`},queryStringParameters:{force:'1'}});
  return{...result,payload:JSON.parse(result.body),reads};
 }finally{global.fetch=previous.fetch;global.Date=previous.Date;for(const key of Object.keys(process.env))if(!(key in previous.env))delete process.env[key];Object.assign(process.env,previous.env)}
}
test('admin conserva octubre hasta DONE sin generar créditos para las quince casas',async()=>{
 const result=await read();assert.equal(result.statusCode,200);assert.equal(result.payload.accountingTransition.accountingMonth,'2026-10');assert.equal(result.payload.gastos[0].id,'oct-expense');assert.equal(result.payload.propietarios.length,15);assert.ok(result.payload.propietarios.every(o=>o.saldoUsd===0&&o.saldoBsRef===0));assert.equal(result.reads,2);
});
for(const state of ['LOCKED','ERROR_PARTIAL'])test(`admin no publica saldos con cierre ${state}`,async()=>{const result=await read([marker(state)]);assert.equal(result.statusCode,503);assert.equal(result.payload.propietarios,undefined)});
test('admin descarta cambios de cierre durante lectura',async()=>{const result=await read([],[marker('DONE')]);assert.equal(result.statusCode,503);assert.equal(result.payload.code,'ACCOUNTING_TRANSITION_CHANGED')});
test('admin pasa a noviembre solo tras DONE estable y no reutiliza pagos de octubre',async()=>{const result=await read([marker('DONE')],[marker('DONE')],true);assert.equal(result.statusCode,200);assert.equal(result.payload.accountingTransition.accountingMonth,'2026-11');assert.ok(result.payload.propietarios.every(o=>o.saldoUsd===20))});
