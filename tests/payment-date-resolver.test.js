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

test('Zelle sin fecha usa provisionalmente la fecha del reporte y requiere revisión',()=>{
  const result=resolver.resolveSubmittedDate({method:'ZELLE',clientDate:'2026-08-06',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.deepEqual([result.transactionDate,result.transactionDateSource,result.transactionDateConfidence,result.transactionDateNeedsReview],['2026-08-08','UNDETERMINED','LOW',true]);
  assert.match(result.transactionDateEvidence,/provisionalmente.*fecha del reporte.*Venezuela/i);
});

test('Binance con fecha visible usa la fecha visible autenticada',()=>{
  const result=resolver.resolveSubmittedDate({method:'BINANCE_PAY',trustedProofDate:trusted('2026-08-05'),now});
  assert.equal(result.transactionDate,'2026-08-05');assert.equal(result.transactionDateSource,'PROOF_EXTRACTED');
});

test('Binance sin fecha no usa recepción ni metadatos como fecha de pago',()=>{
  const result=resolver.resolvePrefillDate({method:'BINANCE_PAY',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(result.transactionDate,'');assert.equal(result.transactionDateSource,'UNDETERMINED');assert.equal(result.transactionDateNeedsReview,true);
});

test('cripto sin fecha queda para revisión',()=>{
  const result=resolver.resolvePrefillDate({method:'CRYPTO_TRANSFER',now});
  assert.equal(result.transactionDate,'');assert.equal(result.transactionDateConfidence,'LOW');
});

test('un cliente no puede declarar PROOF_EXTRACTED sin una prelectura autenticada',()=>{
  const result=resolver.resolveSubmittedDate({method:'TRANSFER_VE',clientDate:'2026-08-07',clientSource:'PROOF_EXTRACTED',now});
  assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'UNDETERMINED');assert.equal(result.transactionDateNeedsReview,true);
});

test('archivo descargado ayer no se convierte en fecha de pago',()=>{
  for(const method of ['ZELLE','BINANCE_PAY','CRYPTO_TRANSFER']){
    const result=resolver.resolveSubmittedDate({method,clientDate:'2026-08-07',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-07T12:00:00Z')},now});
    assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'UNDETERMINED');assert.equal(result.transactionDateNeedsReview,true);
  }
});

test('ningún comprobante usa metadatos de archivo como fecha de pago',()=>{
  const result=resolver.resolveSubmittedDate({method:'TRANSFER_VE',clientDate:'2026-08-06',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-08');assert.equal(result.transactionDateSource,'UNDETERMINED');assert.equal(result.transactionDateNeedsReview,true);
});

test('una fecha editada por el propietario se conserva, pero no autoriza aprobación automática',()=>{
  const result=resolver.resolveSubmittedDate({method:'TRANSFER_VE',clientDate:'2026-08-06',clientSource:'USER_CONFIRMED',now});
  assert.deepEqual([result.transactionDate,result.transactionDateSource,result.transactionDateConfidence,result.transactionDateNeedsReview],['2026-08-06','USER_CONFIRMED','MEDIUM',true]);
});

test('efectivo usa automáticamente el día del reporte en hora de Venezuela',()=>{
  const nearMidnightUtc=new Date('2026-08-15T02:30:00.000Z');
  const result=resolver.resolveSubmittedDate({paymentChannel:'CASH',clientDate:'2026-01-01',clientSource:'PROOF_EXTRACTED',now:nearMidnightUtc});
  assert.deepEqual([result.transactionDate,result.transactionDateSource,result.transactionDateConfidence,result.transactionDateNeedsReview],['2026-08-14','USER_CONFIRMED','HIGH',false]);
  assert.match(result.transactionDateEvidence,/servidor.*reporte de efectivo.*Venezuela/i);
});
