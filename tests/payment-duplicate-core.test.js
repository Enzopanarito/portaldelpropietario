'use strict';

const assert=require('assert');
const duplicate=require('../netlify/functions/_shared/_payment_duplicate_core');

(()=>{
 assert.strictEqual(duplicate.normalizeText('Enzo José, Panarito.'),'ENZO JOSE PANARITO');
 assert.strictEqual(duplicate.normalizeReference('000-123 45'),'00012345');
 assert.strictEqual(duplicate.normalizeCurrency('Bs BCV'),'VES');
 assert.strictEqual(duplicate.normalizeCurrency('usd'),'USD');
 assert.strictEqual(duplicate.normalizeExactSha('A'.repeat(64)),'a'.repeat(64));
 assert.strictEqual(duplicate.normalizeExactSha('not-a-sha'),'');
 const canonical=duplicate.canonicalFingerprint({bank_or_platform:'Banco de Venezuela',method:'TRANSFER_VE',reference:'000-123',currency:'VES',amount:1000,transaction_date:'2026-07-13',recipient_name:'Enzo José Panarito'});
 assert.strictEqual(canonical,'V10|BANCO DE VENEZUELA|TRANSFER VE|000123|VES|1000.00|2026-07-13|');
 assert.match(duplicate.fingerprintHash(canonical),/^v10:[a-f0-9]{64}$/);

 const grayscale=Array.from({length:72},(_,index)=>index%9),hash=duplicate.dHashFromGrayscale(grayscale);assert.match(hash,/^[a-f0-9]{16}$/);assert.strictEqual(duplicate.hammingDistance(hash,hash),0);
 const oneBit=(BigInt(`0x${hash}`)^1n).toString(16).padStart(16,'0');assert.strictEqual(duplicate.hammingDistance(hash,oneBit),1);assert.strictEqual(duplicate.hammingDistance(hash,'bad'),Infinity);

 const exactSha='a'.repeat(64),v10Fingerprint=duplicate.fingerprintHash(duplicate.canonicalFingerprint({bank_or_platform:'BANCO A',method:'TRANSFER_VE',reference:'0001',currency:'VES',amount:100,transaction_date:'2026-07-13',recipient_account_visible:'01020000000000000001',recipient_document:'14978953'}));
 const reports=[
  {id:'recExact',fields:{'Hash SHA-256':exactSha.toUpperCase(),'Estado':{name:'Rechazado'},'Casa al Reportar':1}},
  {id:'recVisual',fields:{'Hash Perceptual':oneBit,'Estado':'Pendiente','Casa al Reportar':2}},
  {id:'recFingerprint',fields:{'Huella Financiera':v10Fingerprint,'Estado':'Confirmado','Casa al Reportar':3}},
  {id:'recReferenceOnly',fields:{'Referencia Detectada':'000-999','Banco o Plataforma Detectada':'BANCO A','Método Detectado':{name:'TRANSFER_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':200,'Fecha Operación Detectada':'2026-07-12','Estado':'Pendiente','Casa al Reportar':4}}
 ];
 const exact=duplicate.findDuplicateMatches({exactSha,visualHash:hash,fingerprint:'different',reference:'x'},{reports});assert.strictEqual(exact.isDuplicate,true);assert.strictEqual(exact.type,'Hash SHA-256 exacto');assert.strictEqual(exact.strongMatches[0].id,'recExact');assert.strictEqual(exact.strongMatches[0].status,'Rechazado');
 const invalidSha=duplicate.findDuplicateMatches({exactSha:'not-a-sha'},{reports});assert.strictEqual(invalidSha.isDuplicate,false,'Un hash mal formado no puede producir coincidencia exacta.');
 const financial=duplicate.findDuplicateMatches({fingerprint:v10Fingerprint,reference:'nope'},{reports,excludeIds:['recExact','recVisual']});assert.strictEqual(financial.isDuplicate,true);assert.strictEqual(financial.type,'Huella transaccional V10 exacta');assert.strictEqual(financial.strongMatches[0].id,'recFingerprint');
 const legacyFinancial=duplicate.findDuplicateMatches({fingerprint:'LEGACY_FP'},{history:[{id:'recLegacy',fields:{'Huella Financiera':'LEGACY_FP'}}]});assert.strictEqual(legacyFinancial.isDuplicate,false,'Una huella histórica sin versión V10 no puede bloquear por sí sola.');

 const visual=duplicate.findDuplicateMatches({visualHash:hash},{reports,excludeIds:['recExact','recFingerprint']});
 assert.strictEqual(visual.isDuplicate,false,'Una plantilla visualmente parecida no puede bloquear un pago por sí sola.');
 assert.strictEqual(visual.possibleDuplicate,true,'La similitud visual debe conservarse como alerta.');
 assert.strictEqual(visual.type,'Similitud visual');
 assert.strictEqual(visual.partialMatches[0].visualDistance,1);
 assert.strictEqual(visual.partialMatches[0].strong,false);

 const sameReferenceDifferentBank=duplicate.findDuplicateMatches({reference:'000999',bank_or_platform:'BANCO B',method:'TRANSFER_VE',currency:'VES',amount:300,transaction_date:'2026-07-11'},{reports});
 assert.strictEqual(sameReferenceDifferentBank.isDuplicate,false,'La misma referencia en otra entidad no debe declararse duplicado.');
 assert.strictEqual(sameReferenceDifferentBank.possibleDuplicate,true);
 assert.strictEqual(sameReferenceDifferentBank.type,'Referencia coincidente');

 const sameBankReferenceWrongContext=duplicate.findDuplicateMatches({reference:'000999',bank_or_platform:'BANCO A',method:'TRANSFER_VE',currency:'USD',amount:9999,transaction_date:'2026-08-10'},{reports});
 assert.strictEqual(sameBankReferenceWrongContext.isDuplicate,false,'Banco + referencia no bastan si monto, moneda o fecha contradicen la operación previa.');
 assert.strictEqual(sameBankReferenceWrongContext.possibleDuplicate,true);
 assert.strictEqual(sameBankReferenceWrongContext.type,'Banco + referencia, evidencia incompleta');

 const exactTransactionReports=[{id:'recCasa5',fields:{'Referencia Detectada':'0503488','Banco o Plataforma Detectada':'BANESCO','Método Detectado':{name:'MOBILE_PAYMENT_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':81057,'Fecha Operación Detectada':'2026-08-10','Estado':'Confirmado','Casa al Reportar':5}}];
 const duplicateAcrossHouse=duplicate.findDuplicateMatches({reference:'0503488',bank_or_platform:'BANESCO',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:81057,transaction_date:'2026-08-10'},{reports:exactTransactionReports});
 assert.strictEqual(duplicateAcrossHouse.isDuplicate,true,'La misma identidad transaccional exacta debe detectarse aunque se reporte desde otra casa.');
 assert.strictEqual(duplicateAcrossHouse.type,'Identidad transaccional exacta');
 assert.strictEqual(duplicateAcrossHouse.strongMatches[0].house,5);
 assert.deepStrictEqual(duplicateAcrossHouse.strongMatches[0].evidence.slice(0,5),['bank','reference','currency','amount','date']);

 const changedAmount=duplicate.findDuplicateMatches({reference:'0503488',bank_or_platform:'BANESCO',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:45000,transaction_date:'2026-08-10'},{reports:exactTransactionReports});
 assert.strictEqual(changedAmount.isDuplicate,false,'Una referencia coincidente con monto contradictorio no alcanza certeza de duplicado.');
 assert.strictEqual(changedAmount.possibleDuplicate,true);

 const visualAndReferenceReports=[{id:'recVisualFinancial',fields:{'Hash Perceptual':oneBit,'Referencia Detectada':'5646','Banco o Plataforma Detectada':'BANCO DE VENEZUELA','Método Detectado':{name:'MOBILE_PAYMENT_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':81057,'Fecha Operación Detectada':'2026-08-10','Estado':'Confirmado','Casa al Reportar':9}}];
 const visualAndReference=duplicate.findDuplicateMatches({visualHash:hash,reference:'5646',bank_or_platform:'BANCO DE VENEZUELA',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:12345,transaction_date:'2026-08-11'},{reports:visualAndReferenceReports});
 assert.strictEqual(visualAndReference.isDuplicate,false,'Similitud visual + referencia no deben condenar si los demás datos contradicen la operación.');
 assert.strictEqual(visualAndReference.possibleDuplicate,true);
 assert.ok(visualAndReference.matches.some(match=>match.matchType==='Similitud visual'&&match.strong===false));
 assert.ok(visualAndReference.matches.some(match=>match.matchType==='Banco + referencia, evidencia incompleta'&&match.strong===false));

 const casa5Like=[{id:'recOtherMobilePayment',fields:{'Hash Perceptual':oneBit,'Referencia Detectada':'062213441122','Banco o Plataforma Detectada':'BANESCO','Método Detectado':{name:'MOBILE_PAYMENT_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':113627.32,'Fecha Operación Detectada':'2026-08-09','Estado':'Confirmado','Casa al Reportar':4}}];
 const casa5FalsePositive=duplicate.findDuplicateMatches({visualHash:hash,reference:'0503488',bank_or_platform:'BANESCO',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:81057,transaction_date:'2026-08-10'},{reports:casa5Like});
 assert.strictEqual(casa5FalsePositive.isDuplicate,false,'Mismo banco y formato, pero otra referencia, no debe bloquearse.');
 assert.strictEqual(casa5FalsePositive.possibleDuplicate,true);
 assert.strictEqual(casa5FalsePositive.type,'Similitud visual');

 const paymentMatch=duplicate.findDuplicateMatches({exactSha:'b'.repeat(64)},{payments:[{id:'recPayment',fields:{'Hash SHA-256':'b'.repeat(64),'Fecha de Pago':'2026-07-10'}}]});assert.strictEqual(paymentMatch.isDuplicate,true);assert.strictEqual(paymentMatch.strongMatches[0].kind,'payment');
 const none=duplicate.findDuplicateMatches({exactSha:'c'.repeat(64),reference:'unique'},{reports});assert.strictEqual(none.isDuplicate,false);assert.strictEqual(none.possibleDuplicate,false);assert.strictEqual(none.type,'Sin coincidencia');
 console.log('PAYMENT_DUPLICATE_CORE_OK');
})();
