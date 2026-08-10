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
 assert.strictEqual(canonical,'BANCO DE VENEZUELA|TRANSFER VE|000123|VES|1000.00|2026-07-13|ENZO JOSE PANARITO');
 assert.match(duplicate.fingerprintHash(canonical),/^[a-f0-9]{64}$/);

 const grayscale=Array.from({length:72},(_,index)=>index%9),hash=duplicate.dHashFromGrayscale(grayscale);assert.match(hash,/^[a-f0-9]{16}$/);assert.strictEqual(duplicate.hammingDistance(hash,hash),0);
 const oneBit=(BigInt(`0x${hash}`)^1n).toString(16).padStart(16,'0');assert.strictEqual(duplicate.hammingDistance(hash,oneBit),1);assert.strictEqual(duplicate.hammingDistance(hash,'bad'),Infinity);

 const exactSha='a'.repeat(64),fingerprint='BANCO|TRANSFER VE|0001|VES|100.00|2026-07-13|ENZO PANARITO';
 const reports=[{id:'recExact',fields:{'Hash SHA-256':exactSha.toUpperCase(),'Estado':{name:'Rechazado'},'Casa al Reportar':1}},{id:'recVisual',fields:{'Hash Perceptual':oneBit,'Estado':'Pendiente','Casa al Reportar':2}},{id:'recFingerprint',fields:{'Huella Financiera':fingerprint,'Estado':'Confirmado','Casa al Reportar':3}},{id:'recReferenceOnly',fields:{'Referencia Detectada':'000-999','Banco o Plataforma Detectada':'BANCO A','Método Detectado':{name:'TRANSFER_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':200,'Fecha Operación Detectada':'2026-07-12','Receptor Detectado':'ENZO PANARITO','Estado':'Pendiente'}}];
 const exact=duplicate.findDuplicateMatches({exactSha,visualHash:hash,fingerprint:'different',reference:'x'},{reports});assert.strictEqual(exact.isDuplicate,true);assert.strictEqual(exact.type,'Hash exacto');assert.strictEqual(exact.strongMatches[0].id,'recExact');assert.strictEqual(exact.strongMatches[0].status,'Rechazado');
 const invalidSha=duplicate.findDuplicateMatches({exactSha:'not-a-sha'},{reports});assert.strictEqual(invalidSha.isDuplicate,false,'Un hash mal formado no puede producir coincidencia exacta.');
 const financial=duplicate.findDuplicateMatches({fingerprint,reference:'nope'},{reports,excludeIds:['recExact','recVisual']});assert.strictEqual(financial.isDuplicate,true);assert.strictEqual(financial.type,'Huella financiera exacta');assert.strictEqual(financial.strongMatches[0].id,'recFingerprint');

 const visual=duplicate.findDuplicateMatches({visualHash:hash},{reports,excludeIds:['recExact','recFingerprint']});
 assert.strictEqual(visual.isDuplicate,false,'Una plantilla visualmente parecida no puede bloquear un pago por sí sola.');
 assert.strictEqual(visual.possibleDuplicate,true,'La similitud visual debe conservarse como alerta.');
 assert.strictEqual(visual.type,'Hash visual');
 assert.strictEqual(visual.partialMatches[0].visualDistance,1);
 assert.strictEqual(visual.partialMatches[0].strong,false);

 const partial=duplicate.findDuplicateMatches({reference:'000999',bank_or_platform:'BANCO B',method:'TRANSFER_VE',currency:'VES',amount:300,transaction_date:'2026-07-11',recipient_name:'OTRO TITULAR'},{reports});assert.strictEqual(partial.isDuplicate,false,'La referencia aislada no declara duplicidad.');assert.strictEqual(partial.possibleDuplicate,true);assert.strictEqual(partial.type,'Referencia parcial');assert.strictEqual(partial.partialMatches[0].strong,false);
 const contextual=duplicate.findDuplicateMatches({reference:'000999',bank_or_platform:'BANCO A',method:'TRANSFER_VE',currency:'VES',amount:200,transaction_date:'2026-07-12',recipient_name:'ENZO PANARITO'},{reports});assert.strictEqual(contextual.isDuplicate,true,'Referencia, moneda, monto y fecha idénticos deben bloquear la reutilización.');assert.strictEqual(contextual.type,'Referencia financiera exacta');assert.strictEqual(contextual.strongMatches[0].context.ratio,1);

 const visualAndFinancialReports=[{id:'recVisualFinancial',fields:{'Hash Perceptual':oneBit,'Referencia Detectada':'5646','Banco o Plataforma Detectada':'BANCO DE VENEZUELA','Método Detectado':{name:'MOBILE_PAYMENT_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':81057,'Fecha Operación Detectada':'2026-08-10','Estado':'Confirmado','Casa al Reportar':9}}];
 const visualAndFinancial=duplicate.findDuplicateMatches({visualHash:hash,reference:'5646',bank_or_platform:'BANCO DE VENEZUELA',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:81057,transaction_date:'2026-08-10'},{reports:visualAndFinancialReports});
 assert.strictEqual(visualAndFinancial.isDuplicate,true,'La similitud visual no debe ocultar una coincidencia financiera fuerte.');
 assert.strictEqual(visualAndFinancial.type,'Referencia financiera exacta');
 assert.ok(visualAndFinancial.matches.some(match=>match.matchType==='Hash visual'&&match.strong===false));
 assert.ok(visualAndFinancial.matches.some(match=>match.matchType==='Referencia financiera exacta'&&match.strong===true));

 const casa5Like=[{id:'recOtherMobilePayment',fields:{'Hash Perceptual':oneBit,'Referencia Detectada':'062213441122','Banco o Plataforma Detectada':'PAGO MOVIL','Método Detectado':{name:'MOBILE_PAYMENT_VE'},'Moneda Detectada':{name:'VES'},'Monto Detectado':113627.32,'Fecha Operación Detectada':'2026-08-09','Estado':'Confirmado','Casa al Reportar':4}}];
 const casa5FalsePositive=duplicate.findDuplicateMatches({visualHash:hash,reference:'5646',bank_or_platform:'PAGO MOVIL',method:'MOBILE_PAYMENT_VE',currency:'VES',amount:81057,transaction_date:'2026-08-10'},{reports:casa5Like});
 assert.strictEqual(casa5FalsePositive.isDuplicate,false,'Caso Casa 5: otra captura del mismo formato no debe bloquearse si cambia la operación.');
 assert.strictEqual(casa5FalsePositive.possibleDuplicate,true,'Caso Casa 5: la semejanza visual sí debe quedar marcada para revisión.');
 assert.strictEqual(casa5FalsePositive.type,'Hash visual');

 const paymentMatch=duplicate.findDuplicateMatches({exactSha:'b'.repeat(64)},{payments:[{id:'recPayment',fields:{'Hash SHA-256':'b'.repeat(64),'Fecha de Pago':'2026-07-10'}}]});assert.strictEqual(paymentMatch.isDuplicate,true);assert.strictEqual(paymentMatch.strongMatches[0].kind,'payment');
 const historyMatch=duplicate.findDuplicateMatches({fingerprint:'HISTORY_FP'},{history:[{id:'recHistory',fields:{'Huella Financiera':'HISTORY_FP'}}]});assert.strictEqual(historyMatch.isDuplicate,true);assert.strictEqual(historyMatch.strongMatches[0].kind,'history');
 const none=duplicate.findDuplicateMatches({exactSha:'c'.repeat(64),reference:'unique'},{reports});assert.strictEqual(none.isDuplicate,false);assert.strictEqual(none.possibleDuplicate,false);assert.strictEqual(none.type,'Sin coincidencia');
 console.log('PAYMENT_DUPLICATE_CORE_OK');
})();
