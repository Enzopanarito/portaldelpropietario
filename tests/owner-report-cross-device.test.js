'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const path=require('path');

process.env.ADMIN_TOKEN_SECRET='a'.repeat(64);
process.env.PAYMENT_PROOF_ENCRYPTION_KEY='b'.repeat(64);
process.env.AIRTABLE_API_TOKEN='test-token';
process.env.AIRTABLE_BASE_ID='appTEST0000000001';
process.env.VLA_DATA_ENVIRONMENT='staging';

const session=require('../netlify/functions/_shared/_owner_report_session');
const ownerA='recAAAAAAAAAAAAAA',ownerB='recBBBBBBBBBBBBBB',reportA='recREPORTAAAAAAA1',reportB='recREPORTBBBBBBB2';

function parse(response){return JSON.parse(response.body)}
function event(body,cookie=''){return{httpMethod:'POST',headers:{'x-forwarded-for':'192.0.2.60',...(cookie?{cookie}:{})},body:JSON.stringify(body)}}

test('el desafío OTP y la sesión quedan ligados al propietario, expiran y usan cookie HttpOnly',()=>{
 const now=Date.UTC(2026,7,20,19,0,0),issued=session.issueChallenge(ownerA,{now,nonce:'1'.repeat(32)});
 assert.match(issued.code,/^\d{6}$/);
 assert.equal(session.verifyChallengeCode(ownerA,issued.challenge,issued.code,{now:now+1000}),true);
 assert.equal(session.verifyChallengeCode(ownerB,issued.challenge,issued.code,{now:now+1000}),false);
 assert.equal(session.verifyChallengeCode(ownerA,issued.challenge,'000000',{now:now+1000}),issued.code==='000000');
 assert.equal(session.verifyChallengeCode(ownerA,issued.challenge,issued.code,{now:now+session.CHALLENGE_TTL_MS+session.CLOCK_SKEW_MS+1}),false);
 const token=session.issueOwnerSession(ownerA,{now,jti:'2'.repeat(32)}),claims=session.verifyOwnerSession(token,ownerA,{now:now+1000});
 assert.equal(claims.ownerId,ownerA);assert.equal(session.verifyOwnerSession(token,ownerB,{now:now+1000}),null);
 const cookie=session.sessionCookie(token);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
});

function loadSessionEndpoint(state){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-owner-report-session.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_access_control')return{TABLES:{propietarios:'Propietarios'},airtableGetRecord:async()=>({id:ownerA,fields:{Casa:1,Email:'owner@example.com'}})};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_shared/_mailer')return{sendMail:async mail=>{state.mail=mail;return{sent:true}}};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/public-owner-report-session')];
 const loaded=require('../netlify/functions/public-owner-report-session');Module._load=original;return loaded;
}

test('la verificación por correo no revela la dirección y emite una sesión segura',async()=>{
 const state={mail:null},handler=loadSessionEndpoint(state).handler;
 const requested=await handler(event({action:'request',ownerId:ownerA})),requestBody=parse(requested);
 assert.equal(requested.statusCode,200);assert.ok(requestBody.challenge);assert.equal(Object.hasOwn(requestBody,'email'),false);
 assert.equal(state.mail.to,'owner@example.com');
 const code=session.challengeCode(requestBody.challenge);
 const verified=await handler(event({action:'verify',ownerId:ownerA,challenge:requestBody.challenge,code}));
 assert.equal(verified.statusCode,200);assert.match(verified.headers['Set-Cookie'],/vla_owner_reports=/);assert.match(verified.headers['Set-Cookie'],/HttpOnly/);
});

function loadStatus(records){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-payment-report-status.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_access_control')return{TABLES:{reportes:'Reportes'},airtableListAll:async()=>records,airtableGetRecord:async(_table,id)=>records.find(row=>row.id===id)||null};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/public-payment-report-status')];
 const loaded=require('../netlify/functions/public-payment-report-status');Module._load=original;return loaded;
}

test('una PC sin token ni sesión no descubre reportes; una sesión solo ve los de su propietario',async()=>{
 const records=[
  {id:reportA,fields:{'Propietario que Reporta':[ownerA],Estado:'Pendiente','Estado de Procesamiento':'Recibido','Fecha y Hora del Reporte':'2026-08-20T18:00:00.000Z',Referencia:'A-1111'}},
  {id:reportB,fields:{'Propietario que Reporta':[ownerB],Estado:'Confirmado','Fecha y Hora del Reporte':'2026-08-20T17:00:00.000Z',Referencia:'B-2222'}}
 ],handler=loadStatus(records).handler;
 let response=await handler(event({ownerId:ownerA,reports:[]}));assert.equal(response.statusCode,401);assert.equal(parse(response).verificationRequired,true);
 const token=session.issueOwnerSession(ownerA),cookie=session.sessionCookie(token).split(';')[0];
 response=await handler(event({ownerId:ownerA,reports:[]},cookie));assert.equal(response.statusCode,200);assert.equal(parse(response).authorization,'verified-device');assert.deepEqual(parse(response).reports.map(row=>row.reportId),[reportA]);
 response=await handler(event({ownerId:ownerB,reports:[]},cookie));assert.equal(response.statusCode,401);assert.equal(parse(response).reports,undefined);
});

function loadSupplement(state){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent&&String(parent.filename||'').endsWith(path.join('netlify','functions','public-payment-report-supplement.js'))){
   if(request==='./_shared/_airtable_meter')return{withAirtableUsage:(_name,handler)=>handler};
   if(request==='./_shared/_access_control')return{TABLES:{reportes:'Reportes'},airtableGetRecord:async()=>state.record,airtablePatchRecord:async(_table,_id,patch)=>{state.patch=patch;state.patchCount++;return{id:state.record.id,fields:{...state.record.fields,...patch}}}};
   if(request==='./_shared/_security_utils')return{cleanPlainText:(value,max)=>String(value||'').slice(0,max),safeDisplayText:(value,max)=>String(value||'').slice(0,max)};
   if(request==='./_shared/_persistent_rate_limit')return{consume:async()=>({allowed:true})};
   if(request==='./_shared/_payment_admin_decision')return{appendAudit:()=>'{"safe":true}'};
   if(request==='./_shared/_payment_report_attachment')return{decodeAttachment:()=>null};
   if(request==='./_shared/_payment_proof_store')return{createProofStore:()=>{throw new Error('No debe abrir Blobs sin adjunto.')}};
   if(request==='./_shared/_blobs_compat')return{connectLambdaEvent:()=>{throw new Error('No debe conectar Blobs sin adjunto.')}};
  }
  return original.apply(this,arguments);
 };
 delete require.cache[require.resolve('../netlify/functions/public-payment-report-supplement')];
 const loaded=require('../netlify/functions/public-payment-report-supplement');Module._load=original;return loaded;
}

test('un dispositivo verificado puede responder el mismo reporte sin token local y sin tocar saldos',async()=>{
 const state={patch:null,patchCount:0,record:{id:reportA,fields:{'Propietario que Reporta':[ownerA],Estado:'Pendiente','Estado de Procesamiento':'Información solicitada','Solicitud de Información':'Aclara la referencia'}}},handler=loadSupplement(state).handler;
 const cookie=session.sessionCookie(session.issueOwnerSession(ownerA)).split(';')[0];
 let response=await handler(event({ownerId:ownerA,reportId:reportA,token:'',message:'Aclaración desde la PC'},cookie));
 assert.equal(response.statusCode,200,JSON.stringify(parse(response)));assert.equal(state.patchCount,1);assert.match(state.patch['Respuesta del Propietario'],/Aclaración desde la PC/);
 assert.equal(Object.keys(state.patch).some(key=>/saldo|acceso|pago definitivo/i.test(key)),false);
 const wrongCookie=session.sessionCookie(session.issueOwnerSession(ownerB)).split(';')[0];state.patchCount=0;
 response=await handler(event({ownerId:ownerA,reportId:reportA,token:'',message:'No autorizado'},wrongCookie));assert.equal(response.statusCode,404);assert.equal(state.patchCount,0);
});

test('la capa cliente conserva tokens locales pero añade verificación y sincronización por servidor',()=>{
 const fs=require('fs'),source=fs.readFileSync(path.join(__dirname,'..','owner-report-sync-v1.js'),'utf8');
 assert.match(source,/vla-payment-reports-v1:/);assert.match(source,/payment-reports\/session/);assert.match(source,/verificationRequired/);assert.match(source,/credentials:'same-origin'/);
 assert.match(source,/stopImmediatePropagation/);assert.doesNotMatch(source,/ADMIN_TOKEN_SECRET|PAYMENT_PROOF_ENCRYPTION_KEY/);
});
