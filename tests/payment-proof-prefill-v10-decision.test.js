'use strict';
const assert=require('assert');
const prefill=require('../netlify/functions/payment-proof-prefill-v10');

(()=>{
 const verified={status:'VERIFIED',reasonCode:'RECIPIENT_VERIFIED'};
 let result=prefill.determineValidation({analysis:{possible_visual_modification:false},recipient:verified,duplicate:{isDuplicate:false,possibleDuplicate:false},validation:{issueCodes:[]}});assert.strictEqual(result.action,'NORMAL');
 result=prefill.determineValidation({analysis:{possible_visual_modification:false},recipient:{status:'REJECTED',reasonCode:'RECIPIENT_EMAIL_MISMATCH',message:'correo incorrecto'},duplicate:{isDuplicate:false,possibleDuplicate:false},validation:{issueCodes:[]}});assert.strictEqual(result.action,'REJECT');assert.strictEqual(result.canSubmit,false);
 result=prefill.determineValidation({analysis:{possible_visual_modification:false},recipient:{status:'REVIEW',reasonCode:'RECIPIENT_NOT_VISIBLE'},duplicate:{isDuplicate:false,possibleDuplicate:false},validation:{issueCodes:[]}});assert.strictEqual(result.action,'ADMIN_REVIEW');assert.strictEqual(result.canSubmit,true);
 result=prefill.determineValidation({analysis:{possible_visual_modification:false},recipient:verified,duplicate:{isDuplicate:true,possibleDuplicate:true,strongMatches:[{matchType:'Identidad transaccional exacta'}]},validation:{issueCodes:[]}});assert.strictEqual(result.action,'DUPLICATE_CONFIRM');assert.strictEqual(result.requiresOwnerConfirmation,true);
 result=prefill.determineValidation({analysis:{possible_visual_modification:false},recipient:{status:'REJECTED',reasonCode:'RECIPIENT_EMAIL_MISMATCH',message:'correo incorrecto'},duplicate:{isDuplicate:false,possibleDuplicate:false},validation:{issueCodes:['LOW_CONFIDENCE']}});assert.strictEqual(result.action,'ADMIN_REVIEW','Con lectura incierta no se debe rechazar categóricamente por un dato OCR dudoso.');
 result=prefill.determineValidation({analysis:{possible_visual_modification:true},recipient:verified,duplicate:{isDuplicate:false,possibleDuplicate:false},validation:{issueCodes:[]}});assert.strictEqual(result.action,'ADMIN_REVIEW');
 result=prefill.determineValidation({analysis:{possible_visual_modification:true},recipient:{status:'REVIEW'},duplicate:{isDuplicate:true,possibleDuplicate:true,strongMatches:[{matchType:'Hash SHA-256 exacto'}]},validation:{issueCodes:['LOW_CONFIDENCE']}});assert.strictEqual(result.action,'DUPLICATE_CONFIRM','El mismo archivo byte-a-byte sigue siendo duplicado aunque la IA falle.');
 console.log('PAYMENT_PREFILL_V10_DECISION_OK');
})();
