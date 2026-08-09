'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const resolver=require('../netlify/functions/_shared/_payment_date_resolver');

const now=new Date('2026-08-08T18:00:00.000Z');

test('prioriza la fecha visible del comprobante',()=>{
  const result=resolver.resolvePrefillDate({proofDate:'2026-08-07',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.deepEqual({date:result.transactionDate,source:result.transactionDateSource,confidence:result.transactionDateConfidence,review:result.transactionDateNeedsReview},{date:'2026-08-07',source:'PROOF_EXTRACTED',confidence:'HIGH',review:false});
});

test('usa los metadatos plausibles del archivo cuando la fecha no es visible',()=>{
  const result=resolver.resolvePrefillDate({proofDate:null,attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-06');
  assert.equal(result.transactionDateSource,'FILE_LAST_MODIFIED');
  assert.equal(result.transactionDateConfidence,'MEDIUM');
  assert.equal(result.transactionDateNeedsReview,true);
});

test('usa la fecha oficial de Venezuela si no hay metadatos confiables',()=>{
  const result=resolver.resolvePrefillDate({proofDate:null,attachment:{lastModified:Date.parse('2030-01-01T00:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-08');
  assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
  assert.equal(result.transactionDateConfidence,'LOW');
  assert.equal(result.transactionDateNeedsReview,true);
});

test('el servidor contrasta la fecha del archivo y rechaza una etiqueta manipulada',()=>{
  const trusted=resolver.resolveSubmittedDate({clientDate:'2026-08-06',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(trusted.transactionDateSource,'FILE_LAST_MODIFIED');
  const mismatched=resolver.resolveSubmittedDate({clientDate:'2026-08-05',clientSource:'FILE_LAST_MODIFIED',attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
  assert.equal(mismatched.transactionDate,'2026-08-08');
  assert.equal(mismatched.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
});

for(const [label,method] of [['Zelle','ZELLE'],['Binance','BINANCE_PAY']]){
  test(`${label} con fecha visible usa la fecha del comprobante`,()=>{
    const result=resolver.resolvePrefillDate({proofDate:'2026-08-07',method,attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
    assert.equal(result.transactionDate,'2026-08-07');
    assert.equal(result.transactionDateSource,'PROOF_EXTRACTED');
  });
  test(`${label} sin fecha usa el timestamp oficial de recepción en Caracas`,()=>{
    const result=resolver.resolvePrefillDate({proofDate:null,method,attachment:{lastModified:Date.parse('2026-08-06T12:00:00Z')},now});
    assert.equal(result.transactionDate,'2026-08-08');
    assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
    assert.equal(result.transactionDateNeedsReview,false);
    assert.match(result.transactionDateEvidence,/America\/Caracas/);
  });
}

test('crypto sin fecha usa el timestamp del servidor',()=>{
  const result=resolver.resolvePrefillDate({proofDate:null,method:'CRYPTO_TRANSFER',now});
  assert.equal(result.transactionDate,'2026-08-08');
  assert.equal(result.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
});

test('un archivo descargado ayer y reportado hoy no cambia la fecha financiera de Zelle',()=>{
  const result=resolver.resolvePrefillDate({proofDate:null,method:'ZELLE',attachment:{lastModified:Date.parse('2026-08-07T12:00:00Z')},now});
  assert.equal(result.transactionDate,'2026-08-08');
  assert.notEqual(result.transactionDateSource,'FILE_LAST_MODIFIED');
});

test('el cliente no puede declarar PROOF_EXTRACTED sin verificación del servidor',()=>{
  const forged=resolver.resolveSubmittedDate({clientDate:'2026-08-01',clientSource:'PROOF_EXTRACTED',paymentChannel:'DIGITAL',method:'ZELLE',proofExtractedVerified:false,now});
  assert.equal(forged.transactionDate,'2026-08-08');
  assert.equal(forged.transactionDateSource,'REPORT_TIMESTAMP_FALLBACK');
  const verified=resolver.resolveSubmittedDate({clientDate:'2026-08-01',clientSource:'PROOF_EXTRACTED',paymentChannel:'DIGITAL',method:'ZELLE',proofExtractedVerified:true,now});
  assert.equal(verified.transactionDate,'2026-08-01');
  assert.equal(verified.transactionDateSource,'PROOF_EXTRACTED');
});
