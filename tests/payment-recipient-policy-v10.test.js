'use strict';
const assert=require('assert');
const policy=require('../netlify/functions/_shared/_payment_recipient_policy_v10');

const now=new Date('2026-08-12T21:00:00Z');
function account(id,fields={}){return{id,fields:{Activo:true,Moneda:'USD',Método:'Zelle','Banco o Plataforma':'Zelle',...fields}}}
const doc='12345678',phone='04145550000',email='payee@example.com',binanceId='123456789',banesco='01340000000000001234';
const env={VLA_AUTHORIZED_RECIPIENT_DOCUMENT:doc,VLA_AUTHORIZED_BINANCE_ID:binanceId};

(()=>{
 assert.strictEqual(policy.normalizeDocument('V-12.345.678'),'12345678');
 assert.strictEqual(policy.normalizePhone('0414-555-0000'),'04145550000');
 assert.strictEqual(policy.normalizeAccount('0134-0000-0000-0000-1234'),'01340000000000001234');

 const zelle=[account('recZ',{Correo:'x','Correo Normalizado':email})];
 assert.strictEqual(policy.validateRecipient({method:'ZELLE',bank_or_platform:'Zelle',recipient_email:'PAYEE@EXAMPLE.COM'},zelle,{now,env}).status,'VERIFIED');
 assert.strictEqual(policy.validateRecipient({method:'ZELLE',bank_or_platform:'Zelle',recipient_email:'other@example.com'},zelle,{now,env}).status,'REJECTED');
 assert.strictEqual(policy.validateRecipient({method:'ZELLE',bank_or_platform:'Zelle',recipient_email:'payee@'},zelle,{now,env}).status,'REVIEW');

 const mobile=[account('recM',{Método:'Pago móvil Venezuela',Moneda:'VES','Banco o Plataforma':'Banesco','Teléfono Normalizado':phone,'Cédula Receptor':doc})];
 let result=policy.validateRecipient({method:'MOBILE_PAYMENT_VE',bank_or_platform:'BANESCO',recipient_phone:'0414-555-0000',recipient_document:'V-12.345.678'},mobile,{now,env});assert.strictEqual(result.status,'VERIFIED');
 result=policy.validateRecipient({method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banesco',recipient_phone:'04140000000',recipient_document:doc},mobile,{now,env});assert.strictEqual(result.status,'REJECTED');assert.strictEqual(result.reasonCode,'RECIPIENT_PHONE_MISMATCH');
 result=policy.validateRecipient({method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banesco',recipient_phone:phone,recipient_document:'99999999'},mobile,{now,env});assert.strictEqual(result.status,'REJECTED');assert.strictEqual(result.reasonCode,'RECIPIENT_DOCUMENT_MISMATCH');
 result=policy.validateRecipient({method:'MOBILE_PAYMENT_VE',bank_or_platform:'Banesco',recipient_phone:phone,recipient_document:'1234'},mobile,{now,env});assert.strictEqual(result.status,'REVIEW');
 result=policy.validateRecipient({method:'MOBILE_PAYMENT_VE',bank_or_platform:'Mercantil',recipient_phone:phone,recipient_document:doc},mobile,{now,env});assert.strictEqual(result.status,'REJECTED');assert.strictEqual(result.reasonCode,'RECIPIENT_BANK_MISMATCH');

 const transfer=[account('recT',{Método:'Transferencia bancaria Venezuela',Moneda:'VES','Banco o Plataforma':'Banesco','Número de Cuenta':banesco,'Cédula Receptor':doc})];
 result=policy.validateRecipient({method:'TRANSFER_VE',bank_or_platform:'Banesco',recipient_account_visible:banesco,recipient_document:doc},transfer,{now,env});assert.strictEqual(result.status,'VERIFIED');
 result=policy.validateRecipient({method:'TRANSFER_VE',bank_or_platform:'Banesco',recipient_account_visible:'1234',recipient_document:doc},transfer,{now,env});assert.strictEqual(result.status,'REVIEW','Una cuenta truncada no puede causar rechazo categórico.');
 result=policy.validateRecipient({method:'TRANSFER_VE',bank_or_platform:'Banesco',recipient_account_visible:'01340000000000009999',recipient_document:doc},transfer,{now,env});assert.strictEqual(result.status,'REJECTED');assert.strictEqual(result.reasonCode,'RECIPIENT_ACCOUNT_MISMATCH');

 const binance=[account('recB',{Método:'Otro',Moneda:'USD','Banco o Plataforma':'Binance','Correo Normalizado':email,'Binance ID':binanceId})];
 assert.strictEqual(policy.validateRecipient({method:'BINANCE_PAY',bank_or_platform:'Binance',recipient_email:email},binance,{now,env}).status,'VERIFIED');
 assert.strictEqual(policy.validateRecipient({method:'BINANCE_PAY',bank_or_platform:'Binance',recipient_binance_id:binanceId},binance,{now,env}).status,'VERIFIED');
 result=policy.validateRecipient({method:'BINANCE_PAY',bank_or_platform:'Binance',recipient_binance_id:'999999999'},binance,{now,env});assert.strictEqual(result.status,'REJECTED');assert.strictEqual(result.reasonCode,'RECIPIENT_BINANCE_ID_MISMATCH');

 const expired=[account('recX',{Correo:'x','Correo Normalizado':email,'Fecha de Vencimiento':'2026-08-11'})];
 assert.strictEqual(policy.validateRecipient({method:'ZELLE',bank_or_platform:'Zelle',recipient_email:email},expired,{now,env}).status,'REVIEW','Un receptor vencido no debe aprobar ni acusar erróneamente al propietario.');
 console.log('PAYMENT_RECIPIENT_POLICY_V10_OK');
})();
