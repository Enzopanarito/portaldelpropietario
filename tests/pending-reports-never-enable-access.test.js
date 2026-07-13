'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const access=require('../netlify/functions/_access_control');
const{pendingReportAccessDecision}=require('../netlify/functions/_pending_report_access_policy');

function owner(){return{id:'recOwner00000001',fields:{Casa:4,Propietario:'Propietario de prueba',Alicuota:0,'Deuda Anterior':185,'Deuda Anterior USD':85,'Deuda Anterior Bs Ref':100,'Estado Acceso Portón':'Limitado','MKJ User ID':'mkj-test-owner'}}}
function pending({id,mode,amount}){return{id,fields:{Estado:'Pendiente','Propietario que Reporta':['recOwner00000001'],'Forma de Pago Reportada':mode,'Monto Reportado':amount,'Equivalente USD Reportado':amount}}}

(async()=>{
 const reports=[pending({id:'recPendingUsd',mode:'USD',amount:500}),pending({id:'recPendingBs',mode:'Bs BCV',amount:500}),pending({id:'recPendingLegacy',mode:'',amount:500})];
 const calc=access.calculateExpiredAccessDebt(owner(),[],reports);
 assert.strictEqual(calc.expiredUsd,85);
 assert.strictEqual(calc.expiredBsRef,100);
 assert.strictEqual(calc.hasExpiredDebt,true);
 assert.strictEqual(calc.pendingUsd,0);
 assert.strictEqual(calc.pendingBsRef,0);
 assert.strictEqual(calc.pendingLegacy,0);
 assert.strictEqual(calc.pendingTotal,0);
 assert.strictEqual(calc.pendingCoversExpiredDebt,false);
 assert.strictEqual(calc.missingUsd,85);
 assert.strictEqual(calc.missingBsRef,100);
 assert.strictEqual(calc.ignoredPendingReports,3);
 assert.deepStrictEqual(calc.ignoredPendingReportIds,['recPendingBs','recPendingLegacy','recPendingUsd']);

 const noDebt=access.calculateExpiredAccessDebt({id:'recNoDebt',fields:{Casa:2,Alicuota:0,'Deuda Anterior':0,'Deuda Anterior USD':0,'Deuda Anterior Bs Ref':0}},[],[pending({id:'recOther',mode:'USD',amount:999})]);
 assert.strictEqual(noDebt.hasExpiredDebt,false);
 assert.strictEqual(noDebt.pendingCoversExpiredDebt,false);

 const decision=pendingReportAccessDecision('recReport0000001');
 assert.deepStrictEqual(decision,{reportId:'recReport0000001',skipped:true,action:'pending-review',temporary:false,reason:'Un reporte pendiente no modifica el portón. La administración debe revisarlo antes de cualquier decisión de acceso.'});

 const previousFetch=global.fetch;
 const previousEnv={...process.env};
 let mkjCalls=0;
 let ownerPatch=null;
 try{
  process.env.AIRTABLE_API_TOKEN='test-token';
  process.env.AIRTABLE_BASE_ID='appTEST0000000001';
  process.env.MKJ_ADMIN_EMAIL='admin@example.invalid';
  process.env.MKJ_ADMIN_PASSWORD='not-used';
  global.fetch=async(url,options={})=>{
   const text=String(url);
   if(text.includes('mkjoules')){mkjCalls+=1;throw new Error('MKJ no debe llamarse en esta prueba.');}
   if((options.method||'GET')==='GET'&&text.includes(encodeURIComponent('Configuración'))){return{ok:true,async json(){return{records:[{id:'recConfig0000001',fields:{'Modo Control Portón':'Automático'}}]}}};}
   if(options.method==='PATCH'&&text.includes(encodeURIComponent('Propietarios'))){ownerPatch=JSON.parse(options.body||'{}');return{ok:true,async json(){return{id:'recOwner00000001',fields:ownerPatch.fields}}};}
   throw new Error(`Solicitud inesperada: ${options.method||'GET'} ${text}`);
  };
  const result=await access.syncOwnerAccess('recOwner00000001',{runMkj:false,sendEmail:false},{owners:[owner()],pagos:[],reportes:reports});
  assert.strictEqual(result.estado,'Limitado');
  assert.strictEqual(result.action,'disable');
  assert.strictEqual(result.temporary,false);
  assert.strictEqual(result.calc.pendingCoversExpiredDebt,false);
  assert.match(result.reason,/reportes pendientes no modifican el acceso/i);
  assert.strictEqual(mkjCalls,0);
  assert.strictEqual(ownerPatch.fields['Estado Acceso Portón'],'Limitado');
 }finally{
  global.fetch=previousFetch;
  for(const key of Object.keys(process.env))if(!(key in previousEnv))delete process.env[key];
  Object.assign(process.env,previousEnv);
 }

 const endpointSource=fs.readFileSync(path.join(__dirname,'..','netlify','functions','public-report-payment.js'),'utf8');
 assert(!/\bsyncOwnerAccess\b/.test(endpointSource),'El endpoint público no puede importar ni llamar syncOwnerAccess.');
 assert(endpointSource.includes("require('./_pending_report_access_policy')"));
 const accessSource=fs.readFileSync(path.join(__dirname,'..','netlify','functions','_access_control.js'),'utf8');
 assert(!accessSource.includes('Habilitación temporal automática por reporte de pago pendiente'));
 assert(!accessSource.includes('podrá habilitar <b>automáticamente</b>'));
 console.log('PENDING_REPORTS_NEVER_ENABLE_ACCESS_OK');
})().catch(error=>{console.error(error);process.exit(1)});
