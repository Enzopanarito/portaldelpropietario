'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluatePaymentReport}=require('../netlify/functions/_shared/_payment_deterministic_arbiter');

function zelleAnalysis(overrides={}){return{
 method:'ZELLE',bank_or_platform:'Zelle',amount:60,currency:'USD',transaction_date:null,transaction_time:null,reference:null,
 transaction_status:'SENT',recipient_name:'Enzo panarito',recipient_email:'enzopanarito@gmail.com',recipient_phone:null,recipient_account_visible:null,
 recipient_account_last4:null,recipient_document:null,recipient_binance_id:null,confidence:.99,critical_fields_visible:false,warnings:[],possible_visual_modification:false,...overrides
}}
const accounts=[{id:'recACCOUNT0000001',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Correo Normalizado':'enzopanarito@gmail.com','Correo Receptor':'enzopanarito@gmail.com','Titular Autorizado':'ENZO JOSE PANARITO','Titulares Alternativos':'Enzo Panarito'}}];

test('Zelle sin referencia ni fecha visible queda en revisión administrativa, no como error ni autopago',()=>{
 const result=evaluatePaymentReport({report:{targetMode:'USD',attachmentRequired:true},attachment:{valid:true,sha256:'a'.repeat(64)},analysis:zelleAnalysis(),authorizedAccounts:accounts,config:{minimumConfidence:.85,automaticApprovalEnabled:true},now:new Date('2026-08-28T15:30:00Z')});
 assert.equal(result.processingState,'Pendiente de administrador');
 assert.equal(result.automaticApproval,false);
 assert(result.reasons.includes('ZELLE_REFERENCE_NOT_VISIBLE'));
 assert(result.reasons.includes('ZELLE_DATE_NOT_VISIBLE'));
 assert.equal(result.receiver.classification,'CONFIRMED');
});

test('otro método digital sin referencia sigue bloqueado por seguridad',()=>{
 const result=evaluatePaymentReport({report:{targetMode:'USD',attachmentRequired:true},attachment:{valid:true,sha256:'b'.repeat(64)},analysis:zelleAnalysis({method:'TRANSFER_US',bank_or_platform:'Bank',critical_fields_visible:true}),authorizedAccounts:accounts,config:{minimumConfidence:.85},now:new Date('2026-08-28T15:30:00Z')});
 assert.equal(result.processingState,'Requiere corrección');
 assert(result.reasons.includes('REFERENCE_MISSING'));
});
