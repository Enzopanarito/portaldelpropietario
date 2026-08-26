'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHandler,previewMode}=require('../netlify/functions/public-punctuality-score');

const OWNER_ID='recABCDEFGHIJKLMN';
function response(statusCode,body){return{statusCode,body:JSON.stringify(body)}}

test('preview devuelve fixture y nunca consulta Airtable',async()=>{
  let reads=0;
  const handler=createHandler({env:{CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'staging'},cache:new Map(),getAll:async()=>{reads++;throw new Error('no debe leer Airtable')},now:()=>new Date('2026-08-25T12:00:00-04:00')});
  const result=await handler({httpMethod:'GET',queryStringParameters:{ownerId:OWNER_ID}}),body=JSON.parse(result.body);
  assert.equal(result.statusCode,200);assert.equal(body.preview,true);assert.equal(body.readOnly,true);assert.equal(reads,0);
});

test('un entorno desconocido o producción jamás activa el fixture ficticio',()=>{
  assert.equal(previewMode({}),false);
  assert.equal(previewMode({VLA_DATA_ENVIRONMENT:'production'}),false);
  assert.equal(previewMode({CONTEXT:'production'}),false);
  assert.equal(previewMode({CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'production'}),false);
  assert.equal(previewMode({CONTEXT:'deploy-preview',VLA_DATA_ENVIRONMENT:'staging'}),true);
  assert.equal(previewMode({VLA_DATA_ENVIRONMENT:'local'}),true);
});

test('producción sin CONTEXT pero con VLA_DATA_ENVIRONMENT=production calcula datos reales',async()=>{
  let built=0;
  const owner={id:OWNER_ID,Casa:10,Alicuota:.06186,'Deuda Anterior':333.17,'Deuda Anterior USD':120,'Deuda Anterior Bs Ref':213.17};
  const publicHandler=async()=>response(200,{propietarios:[owner],pagos:[],automation:{payment:{dueDay:10}}});
  const handler=createHandler({env:{VLA_DATA_ENVIRONMENT:'production',AIRTABLE_API_TOKEN:'test-token',AIRTABLE_BASE_ID:'app4nE4ReGRi2SuP2'},cache:new Map(),publicHandler,getAll:async()=>[],buildPunctualityScore:()=>{built++;return{version:'vla-punctuality-v1',readOnly:true,ownerId:OWNER_ID,casa:10,score:44,level:{key:'TARDIO',label:'Tardío',color:'#ed8b1f'},evaluatedMonths:2,targetMonths:6,forming:true,streak:0,trend:{key:'BAJANDO',label:'Bajando',symbol:'↓'},dueDay:10,history:[],advice:'Prueba',generatedAt:'2026-08-25T12:00:00.000Z'}}});
  const result=await handler({httpMethod:'GET',queryStringParameters:{ownerId:OWNER_ID}}),body=JSON.parse(result.body);
  assert.equal(result.statusCode,200);assert.equal(built,1);assert.equal(body.preview,undefined);assert.equal(body.score,44);assert.equal(result.headers['X-Punctuality-Source'],'LEDGER_AUDIT');
});

test('producción solo ejecuta lecturas y entrega contrato read-only',async()=>{
  const calls=[];
  const owner={id:OWNER_ID,Casa:1,Alicuota:1,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0};
  const publicHandler=async()=>response(200,{propietarios:[owner],pagos:[],automation:{payment:{dueDay:10}}});
  const getAll=async(table,query)=>{calls.push({table,query});return[]};
  let built=0;
  const buildPunctualityScore=args=>{built++;assert.equal(args.owner.id,OWNER_ID);assert.equal(args.dueDay,10);return{version:'vla-punctuality-v1',readOnly:true,ownerId:OWNER_ID,casa:1,score:88,level:{key:'MUY_PUNTUAL',label:'Muy puntual',color:'#36a55c'},evaluatedMonths:1,targetMonths:6,forming:true,streak:0,trend:{key:'FORMACION',label:'En formación',symbol:'•'},dueDay:10,history:[],advice:'Prueba',generatedAt:'2026-08-25T12:00:00.000Z'}};
  const handler=createHandler({env:{CONTEXT:'production',AIRTABLE_API_TOKEN:'test-token',AIRTABLE_BASE_ID:'app4nE4ReGRi2SuP2'},cache:new Map(),publicHandler,getAll,buildPunctualityScore,now:()=>new Date('2026-08-25T12:00:00-04:00')});
  const result=await handler({httpMethod:'GET',queryStringParameters:{ownerId:OWNER_ID}}),body=JSON.parse(result.body);
  assert.equal(result.statusCode,200);assert.equal(result.headers['X-Punctuality-Read-Only'],'true');assert.equal(body.readOnly,true);assert.equal(body.score,88);assert.equal(built,1);assert.equal(calls.length,2);assert.ok(calls.every(call=>typeof call.table==='string'));
});

test('un fallo del índice falla suave y no contamina el estado de cuenta',async()=>{
  const handler=createHandler({env:{CONTEXT:'production',AIRTABLE_API_TOKEN:'test-token',AIRTABLE_BASE_ID:'app4nE4ReGRi2SuP2'},cache:new Map(),publicHandler:async()=>response(500,{message:'fallo'}),getAll:async()=>[],previewMode:()=>false});
  const result=await handler({httpMethod:'GET',queryStringParameters:{ownerId:OWNER_ID}}),body=JSON.parse(result.body);
  assert.equal(result.statusCode,503);assert.match(body.message,/estado de cuenta no se ve afectado/i);assert.equal(result.headers['X-Punctuality-Read-Only'],'true');
});

test('rechaza cualquier método de escritura',async()=>{
  const handler=createHandler({env:{CONTEXT:'production'},cache:new Map(),previewMode:()=>false});
  const result=await handler({httpMethod:'POST',queryStringParameters:{ownerId:OWNER_ID}});
  assert.equal(result.statusCode,405);
});
