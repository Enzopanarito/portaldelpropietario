'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const resolver=require('../netlify/functions/_shared/_payment_date_resolver');

const now=new Date('2026-08-08T18:00:00.000Z');
const trusted=date=>({transactionDate:date,transactionDateSource:'PROOF_EXTRACTED',transactionDateEvidence:'Fecha visible y autenticada por el servidor.'});

test('Zelle con fecha visible usa la fecha visible autenticada',()=>{
  const result=resolver.resolveSubmittedDate({method:'ZELLE',trustedProofDate:trusted('2026-08-07'),now});
  assert.deepEqual([result.transactionDate,result.transactionDateSource,result.transactionDateConfidence,result.transactionDateNeedsReview],['2026-08-07','PROOF_EXTRACTED','HIGH',false]);
});

test('Zelle sin fecha usa automáticamente la recepción del servidor en Caracas',()=>{
  const result=resolver.resolveSubmittedDate({method:'ZELLE',clientDate:'2026-08-06',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.deepEqual([result.transactionDate,result.transactionDateSource,result.transactionDateConfidence,result.transactionDateNeedsReview],['2026-08-08','REPORT_TIMESTAMP_FALLBACK','HIGH',false]);
});

test('Binance con fecha visible usa la fecha visible autenticada',()=>{
  const result=resolver.resolveSubmittedDate({method:'BINANCE_PAY',trustedProofDate:trusted('2026-08-05'),now});
  assert.equal(result.transactionDate,'2026-08-05');assert.equal(result.transactionDateSource,'PROOF_EXTRACTED');
});

test('Binance sin fecha usa automáticamente la recepción del servidor en Caracas',()=>{
  const result=resolver.resolvePrefillDate({method:'BINANCE_PAY',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');assert.equal(result.transactionDateNeedsReview,false);
});

test('cripto sin fecha usa automáticamente la recepción del servidor en Caracas',()=>{
  const result=resolver.resolvePrefillDate({method:'CRYPTO_TRANSFER',now});
  assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateConfidence,'HIGH');
});

test('un cliente no puede declarar PROOF_EXTRACTED sin una prelectura autenticada',()=>{
  const result=resolver.resolveSubmittedDate({method:'TRANSFER_VE',clientDate:'2026-08-07',clientSource:'PROOF_EXTRACTED',now});
  assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
});

test('archivo descargado ayer y reportado hoy usa HOY para Zelle, Binance y cripto',()=>{
  for(const method of ['ZELLE','BINANCE_PAY','CRYPTO_TRANSFER']){
    const result=resolver.resolveSubmittedDate({method,clientDate:'2026-08-07',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-07T12:00:00Z')},now});
    assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
  }
});

test('otros comprobantes conservan el resolver de metadatos cuando tiene sentido',()=>{
  const result=resolver.resolveSubmittedDate({method:'TRANSFER_VE',clientDate:'2026-08-06',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-06');assert.equal(result.transactionDateSource,'FILE_LAST_MODIFIED');assert.equal(result.transactionDateNeedsReview,true);
});
