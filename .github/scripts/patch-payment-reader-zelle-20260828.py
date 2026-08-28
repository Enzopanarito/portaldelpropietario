from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# 1) Prefill: Zelle confirmation screens legitimately omit a bank reference.
path = "netlify/functions/payment-proof-prefill.js"
replace_once(
    path,
    "function requiredFieldsFor(){return['amount','currency','reference','method']}",
    "function requiredFieldsFor(method){const normalized=String(method||'').trim().toUpperCase();return normalized==='ZELLE'?['amount','currency','method']:['amount','currency','reference','method']}",
)

p = Path(path)
text = p.read_text()
marker = "async function analyzeViaProxy({proof,promptVersion,fetchFn=global.fetch,proxyUrl=PROXY_URL}={}){"
if text.count(marker) != 1:
    raise SystemExit("prefill quality marker mismatch")
quality = """function prefillQuality(raw){
 const parsed=contract.parseRawJson(String(raw||''));
 if(!parsed.ok)return{usable:false,complete:false,confidence:0,missing:[{field:'analysis',label:'lectura'}],rank:-1000};
 const analysis=contract.normalizeAnalysis(parsed.value),missing=missingFields(analysis),confidence=Math.max(0,Math.min(1,Number(analysis.confidence)||0)),coreMissing=missing.filter(item=>['amount','currency','method'].includes(item.field)),usable=coreMissing.length===0&&confidence>=0.75,complete=missing.length===0;
 return{usable,complete,confidence,missing,analysis,rank:(usable?1000:0)+(complete?500:0)+confidence*100-missing.length*25};
}

"""
text = text.replace(marker, quality + marker, 1)
start = text.index("async function analyzeWithFallback(")
end = text.index("\n\nconst handler=async event=>", start)
new_func = """async function analyzeWithFallback({config,proof,report,promptVersion}={},deps={}){
 const discover=deps.discoverCompatibleModel||discoverCompatibleModel;
 const direct=deps.analyzeDirect||analyzeDirect;
 const proxy=deps.analyzeViaProxy||analyzeViaProxy;
 const hasLocal=deps.localGeminiConfigured||localGeminiConfigured;
 const proxyFirst=deps.proxyFirst!==false;
 let selection=null,discoveryError=null,lastError=null,firstProxyError=null,bestResult=null,bestQuality=null;
 const consider=result=>{const quality=prefillQuality(result.raw);if(!bestQuality||quality.rank>bestQuality.rank){bestResult=result;bestQuality=quality}return quality};

 if(proxyFirst){
  try{const result=await proxy({proof,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result;lastError=Object.assign(new Error('La primera lectura quedó incompleta.'),{code:'LOW_QUALITY_OUTPUT',quality})}
  catch(error){firstProxyError=error;lastError=error;if(['INVALID_ATTACHMENT','RATE_LIMIT','TIMEOUT','PROVIDER_UNAVAILABLE'].includes(errorCode(error)))throw error}
 }

 if(hasLocal()){
  try{selection=await discover()}
  catch(error){discoveryError=error;lastError=error}
  const discoveryCode=errorCode(discoveryError),directAllowed=!['AI_AUTH_FAILED','AI_NOT_CONFIGURED'].includes(discoveryCode);
  if(directAllowed){
   const models=modelCandidates(config,selection).slice(0,MAX_DIRECT_ATTEMPTS);
   for(const model of models){
    try{const result=await direct({model,proof,report,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result;lastError=Object.assign(new Error('El modelo devolvió una lectura incompleta.'),{code:'LOW_QUALITY_OUTPUT',quality})}
    catch(error){lastError=error;if(!canTryAnotherModel(error))break}
   }
  }
 }

 if(!proxyFirst){
  try{const result=await proxy({proof,promptVersion}),quality=consider(result);if(quality.usable&&quality.complete)return result}
  catch(error){if(!lastError||['AI_AUTH_FAILED','AI_NOT_CONFIGURED'].includes(errorCode(lastError)))lastError=error}
 }
 if(bestResult)return bestResult;
 throw firstProxyError||lastError||Object.assign(new Error('No hay un lector disponible para analizar el comprobante.'),{code:'AI_NOT_CONFIGURED'});
}"""
text = text[:start] + new_func + text[end:]
export_marker = "exports.loadAuthorizedAccounts=loadAuthorizedAccounts;"
if text.count(export_marker) != 1:
    raise SystemExit("prefill export marker mismatch")
text = text.replace(export_marker, "exports.prefillQuality=prefillQuality;\n" + export_marker, 1)
p.write_text(text)

# 2) Owner UI: a confirmed Zelle recipient allows a reference-less confirmation screen.
path = "owner-payment-report-v3.js"
p = Path(path)
text = p.read_text()
marker = "  function digitalMissing(){\n"
if text.count(marker) != 1:
    raise SystemExit("owner digitalMissing marker mismatch")
helper = """  function zelleProofWithoutReference(){
    const method=String(analysisData?.method||'').trim().toUpperCase(),classification=String(analysisData?.recipientClassification||'').trim().toUpperCase(),recipient=String(analysisData?.recipient||'').trim();
    return paymentChannel()==='DIGITAL'&&method==='ZELLE'&&classification==='CONFIRMED'&&!reportReference()&&enteredAmount()>0&&byId('payCurrency')?.value==='USD'&&Boolean(recipient);
  }
"""
text = text.replace(marker, helper + marker, 1)
old = "if(!byId('payRef').value.trim())missing.push('reference');"
if text.count(old) != 1:
    raise SystemExit("owner reference requirement marker mismatch")
text = text.replace(old, "if(!byId('payRef').value.trim()&&!zelleProofWithoutReference())missing.push('reference');", 1)
old = "<span>${detectedReference?`Confirmación ${safeText(shortReference(detectedReference))}`:'Referencia no detectada'}</span>"
new = "<span>${detectedReference?`Confirmación ${safeText(shortReference(detectedReference))}`:zelleProofWithoutReference()?'Zelle no muestra referencia en esta confirmación · se verificará con el receptor':'Referencia no detectada'}</span>"
if text.count(old) != 1:
    raise SystemExit("owner confirmation reference marker mismatch")
text = text.replace(old, new, 1)
p.write_text(text)

# 3) Server intake: accept reference-less Zelle only with a server-signed CONFIRMED recipient.
path = "netlify/functions/public-report-payment.js"
p = Path(path)
text = p.read_text()
old = "    if(paymentChannel==='DIGITAL'&&!rawReference)return json(400,{message:'Debe indicar referencia o confirmación.'});\n"
if text.count(old) != 1:
    raise SystemExit("public early reference marker mismatch")
text = text.replace(old, "", 1)
old = "    const recipientVerification=attachment?verifyRecipientAttestation(body.recipientAttestation,{ownerId,attachmentSha,method},{now:Date.parse(reportTimestamp)}):null;\n"
new = old + "    const zelleNoReference=paymentChannel==='DIGITAL'&&method==='ZELLE'&&!rawReference&&String(recipientVerification?.classification||'').toUpperCase()==='CONFIRMED';\n    if(paymentChannel==='DIGITAL'&&!rawReference&&!zelleNoReference)return json(400,{message:'Debe indicar referencia o confirmación.'});\n"
if text.count(old) != 1:
    raise SystemExit("public recipient marker mismatch")
text = text.replace(old, new, 1)
old = "    const reference=rawReference||(paymentChannel==='CASH'?`EFECTIVO · ${cashReceiver} · ${submissionId.slice(-12)}`:'');\n"
new = "    const reference=rawReference||(paymentChannel==='CASH'?`EFECTIVO · ${cashReceiver} · ${submissionId.slice(-12)}`:(zelleNoReference?`ZELLE-SIN-REF-${attachmentSha.slice(0,16).toUpperCase()}`:''));\n"
if text.count(old) != 1:
    raise SystemExit("public reference assignment marker mismatch")
text = text.replace(old, new, 1)
old = "`Método detectado/confirmado: ${method}`,`Fecha de operación: ${transactionDate||'NO DETECTADA'}`"
new = "`Método detectado/confirmado: ${method}`,zelleNoReference?'Referencia visible: Zelle no muestra una referencia en esta confirmación; se usa una identidad interna derivada del comprobante.':'',`Fecha de operación: ${transactionDate||'NO DETECTADA'}`"
if text.count(old) != 1:
    raise SystemExit("public report context marker mismatch")
text = text.replace(old, new, 1)
old = "        'Referencia Detectada':reference,\n"
new = "        'Referencia Detectada':rawReference,\n"
if text.count(old) != 1:
    raise SystemExit("public detected reference marker mismatch")
text = text.replace(old, new, 1)
p.write_text(text)

# 4) Deterministic arbiter: a Zelle confirmation without reference/date is reviewable, never auto-approved.
path = "netlify/functions/_shared/_payment_deterministic_arbiter.js"
p = Path(path)
text = p.read_text()
old = " checks.push(check('CRITICAL_FIELDS',analysis.critical_fields_visible===true));if(analysis.critical_fields_visible!==true)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['CRITICAL_FIELDS_MISSING'],checks});\n"
new = " const method=clean(analysis.method).toUpperCase(),zelleCoreVisible=method==='ZELLE'&&money(analysis.amount)>0&&clean(analysis.currency)==='USD'&&recipientEvidence(analysis).visible,criticalFieldsOk=analysis.critical_fields_visible===true||zelleCoreVisible;\n checks.push(check('CRITICAL_FIELDS',criticalFieldsOk,zelleCoreVisible&&analysis.critical_fields_visible!==true?'Zelle con monto, moneda y receptor visibles; referencia/fecha pueden requerir revisión.':''));if(!criticalFieldsOk)return resultEnvelope({processingState:'Revisión manual urgente',resultValidation:'Revisión manual urgente',reasons:['CRITICAL_FIELDS_MISSING'],checks});\n"
if text.count(old) != 1:
    raise SystemExit("arbiter critical marker mismatch")
text = text.replace(old, new, 1)
old = " const referenceVisible=Boolean(clean(analysis.reference));checks.push(check('REFERENCE',referenceVisible));if(!referenceVisible)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Referencia no visible',reasons:['REFERENCE_MISSING'],checks});\n const transactionDate=dateMs(analysis.transaction_date),dateOk=Number.isFinite(transactionDate)&&transactionDate<=now.getTime()+24*60*60*1000;checks.push(check('DATE',dateOk,analysis.transaction_date));if(!dateOk)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Fecha inválida',reasons:['TRANSACTION_DATE_INVALID'],checks});\n"
new = " const referenceVisible=Boolean(clean(analysis.reference)),zelleReferenceReview=!referenceVisible&&method==='ZELLE'&&zelleCoreVisible;checks.push(check('REFERENCE',referenceVisible,zelleReferenceReview?'Zelle sin referencia visible; requiere revisión administrativa.':''));if(!referenceVisible&&!zelleReferenceReview)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Referencia no visible',reasons:['REFERENCE_MISSING'],checks});\n const transactionDate=dateMs(analysis.transaction_date),dateOk=Number.isFinite(transactionDate)&&transactionDate<=now.getTime()+24*60*60*1000,zelleDateReview=!dateOk&&method==='ZELLE'&&zelleCoreVisible;checks.push(check('DATE',dateOk,zelleDateReview?'Zelle sin fecha visible; requiere revisión administrativa.':analysis.transaction_date));if(!dateOk&&!zelleDateReview)return resultEnvelope({processingState:'Requiere corrección',resultValidation:'Fecha inválida',reasons:['TRANSACTION_DATE_INVALID'],checks});\n"
if text.count(old) != 1:
    raise SystemExit("arbiter reference/date marker mismatch")
text = text.replace(old, new, 1)
old = " if(recipient.classification==='PROBABLE')return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Receptor probable',reasons:['RECIPIENT_PROBABLE_REVIEW'],checks,receiver:recipient});\n const snapshotOk="
new = " if(recipient.classification==='PROBABLE')return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Receptor probable',reasons:['RECIPIENT_PROBABLE_REVIEW'],checks,receiver:recipient});\n if(zelleReferenceReview||zelleDateReview)return resultEnvelope({processingState:'Pendiente de administrador',resultValidation:'Revisión manual urgente',reasons:[zelleReferenceReview?'ZELLE_REFERENCE_NOT_VISIBLE':'',zelleDateReview?'ZELLE_DATE_NOT_VISIBLE':''],checks,receiver:recipient});\n const snapshotOk="
if text.count(old) != 1:
    raise SystemExit("arbiter admin review marker mismatch")
text = text.replace(old, new, 1)
p.write_text(text)

# 5) Unit regression: exact class of Zelle confirmation supplied by the user.
Path("tests/zelle-confirmation-no-reference.test.js").write_text(r"""'use strict';
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
""")

# Extend prefill unit tests: no visible Zelle reference + low-quality fallback.
p = Path("tests/payment-proof-prefill.test.js")
text = p.read_text()
append = r"""

test('una confirmación Zelle puede estar completa aunque Zelle no muestre referencia ni fecha',async()=>{
 const accounts=[{id:'recACCOUNT0000001',fields:{Activo:true,Método:'Zelle',Moneda:'USD','Correo Normalizado':'enzopanarito@gmail.com','Correo Receptor':'enzopanarito@gmail.com','Titular Autorizado':'ENZO JOSE PANARITO','Titulares Alternativos':'Enzo Panarito'}}];
 const analysis=base({method:'ZELLE',bank_or_platform:'Zelle',amount:60,currency:'USD',reference:null,transaction_date:null,recipient_name:'Enzo panarito',recipient_email:'enzopanarito@gmail.com',critical_fields_visible:false});
 const {handler}=loadWithAnalysis(analysis,{accounts}),response=await handler(event()),body=JSON.parse(response.body);
 assert.equal(response.statusCode,200);assert.equal(body.complete,true);assert.deepEqual(body.missing,[]);assert.equal(body.analysis.amount,60);assert.equal(body.analysis.currency,'USD');assert.equal(body.analysis.recipientClassification,'CONFIRMED');assert.equal(body.analysis.transactionDateNeedsReview,true);
});

test('si la primera IA responde incompleto, prueba otra lectura y conserva la mejor',async()=>{
 const loaded=loadWithAnalysis(base()),incomplete=JSON.stringify(base({reference:null,critical_fields_visible:false})),complete=JSON.stringify(base({reference:'RECOVERED-REF',confidence:.97}));
 const result=await loaded.analyzeWithFallback({config:{primaryModel:'gemini-test'},proof:{},report:{},promptVersion:'V2'},{analyzeViaProxy:async()=>({raw:incomplete,model:'proxy:first',provider:'proxy'}),localGeminiConfigured:()=>true,discoverCompatibleModel:async()=>({model:'direct-second'}),analyzeDirect:async()=>({raw:complete,model:'direct-second',provider:'direct'})});
 assert.equal(result.model,'direct-second');assert.equal(loaded.prefillQuality(result.raw).complete,true);
});
"""
if "una confirmación Zelle puede estar completa" in text:
    raise SystemExit("prefill tests already patched")
p.write_text(text + append)

# Browser regression: the user can submit a Zelle confirmation without inventing a reference.
p = Path("tests/payment-prefill-client-race-browser.cjs")
text = p.read_text()
append = r"""

test('Zelle sin referencia visible llena monto y receptor y habilita envío para revisión',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 const page=await fixturePage(browser);
 try{
  await page.route('**/api/vla/payment-proof-prefill',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,complete:true,analysis:{amount:60,currency:'USD',reference:'',bank:'Zelle',method:'ZELLE',transactionDate:'',transactionDateSource:'UNDETERMINED',transactionDateConfidence:'LOW',transactionDateNeedsReview:true,transactionDateEvidence:'Zelle no muestra fecha en esta pantalla.',transactionStatus:'SENT',recipient:'Enzo panarito · enzopanarito@gmail.com',recipientClassification:'CONFIRMED',recipientNeedsReview:false,confidence:.99,warnings:[]},analysisProvider:'proxy:gemini-test',analysisRoute:'proxy',missing:[]})}));
  await page.setInputFiles('#payProof',proof('zelle-sin-referencia'));
  await page.waitForFunction(()=>document.getElementById('payAmount').value==='60');
  assert.equal(await page.locator('#payRef').inputValue(),'');
  assert.equal(await page.locator('#vla-pay-confirmation').isVisible(),true);
  assert.equal(await page.locator('#submitReport').isEnabled(),true);
  assert.match(await page.locator('#vla-pay-confirm-card').innerText(),/Zelle no muestra referencia/i);
  assert.match(await page.locator('#submitReport').innerText(),/Enviar para revisión/i);
 }finally{await browser.close()}
});
"""
if "Zelle sin referencia visible llena monto" in text:
    raise SystemExit("browser test already patched")
p.write_text(text + append)
