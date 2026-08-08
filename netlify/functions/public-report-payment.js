// netlify/functions/public-report-payment.js
// Reporte público protegido: comprobantes digitales cifrados antes de crear el reporte,
// flujo de efectivo pendiente de confirmación y deduplicación exacta/visual/financiera.

'use strict';

const crypto=require('crypto');
const { withAirtableUsage } = require('./_airtable_meter');
const { airtableCreateRecord, airtableGetRecord, TABLES, money } = require('./_access_control');
const { pendingReportAccessDecision } = require('./_pending_report_access_policy');
const { sendMail } = require('./_mailer');
const { sanitizeReference, escapeHtml, cleanPlainText, safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const { consume } = require('./_persistent_rate_limit');
const { loadLastGood } = require('./_bcv_store');
const { parseAmountInput, resolveAmount } = require('../../payment-report-intelligence');
const { decodeAttachment } = require('./_payment_report_attachment');
const { createProofStore } = require('./_payment_proof_store');
const { computePerceptualHash } = require('./_payment_visual_hash');
const { findDuplicateMatches } = require('./_payment_duplicate_core');
const { sign } = require('./_internal_job_auth');
const { connectLambdaEvent } = require('./_blobs_compat');
const { todayCaracasISO, resolveSubmittedDate } = require('./_payment_date_resolver');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
const ALLOWED_ENTERED_CURRENCIES = new Set(['USD', 'BS']);
const PAYMENT_CHANNELS = new Set(['DIGITAL','CASH']);
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const ABUSE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REPORTS_PER_IP = 12;
const MAX_REPORTS_PER_OWNER = 6;
const POST_CREATE_TIMEOUT_MS = 8000;

function nowCaracasLabel(){return new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}
function fmtUsd(n){return '$'+money(n).toFixed(2);}
function fmtBs(n){return 'Bs. '+money(n).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2});}
function normalizeReference(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();}
function optionalText(value,max){return cleanPlainText(String(value||''),max).trim();}
function normalizePaymentMethod(method,bank=''){
  const explicit=String(method||'').trim().toUpperCase();
  if(['TRANSFER_VE','MOBILE_PAYMENT_VE','ZELLE','TRANSFER_US','BINANCE_PAY','CRYPTO_TRANSFER','OTHER'].includes(explicit))return explicit;
  const hint=String(bank||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if(hint.includes('ZELLE'))return'ZELLE';
  if(hint.includes('BINANCE PAY'))return'BINANCE_PAY';
  if(hint.includes('BINANCE')||hint.includes('CRIPTO')||hint.includes('CRYPTO'))return'CRYPTO_TRANSFER';
  if(hint.includes('PAGO MOVIL'))return'MOBILE_PAYMENT_VE';
  if(hint.includes('TRANSFER'))return'TRANSFER_VE';
  return'OTHER';
}
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)};}
function airtableUrl(tableName,query=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`;}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120);}
async function within(promise,timeoutMs,fallback){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),timeoutMs)})])}finally{clearTimeout(timer)}}
function normalizeAnalysisSummary(value){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return{
    provider:optionalText(source.provider,120),route:optionalText(source.route,40),confidence:Math.max(0,Math.min(1,Number(source.confidence)||0)),
    transactionTime:optionalText(source.transactionTime,20),transactionStatus:optionalText(source.transactionStatus,40),recipient:optionalText(source.recipient,180),
    warnings:(Array.isArray(source.warnings)?source.warnings:[]).slice(0,5).map(item=>optionalText(item,240)).filter(Boolean),possibleVisualModification:source.possibleVisualModification===true,
    prefillComplete:source.prefillComplete===true,missingLabels:(Array.isArray(source.missingLabels)?source.missingLabels:[]).slice(0,8).map(item=>optionalText(item,80)).filter(Boolean)
  };
}
function dateSourceLabel(source){return({PROOF_EXTRACTED:'Leída del comprobante',FILE_LAST_MODIFIED:'Inferida de la fecha del archivo',REPORT_TIMESTAMP_FALLBACK:'Hora oficial del reporte',USER_CONFIRMED:'Editada o confirmada por el propietario'}[source]||source||'No identificada')}

async function rateLimit(scope,identity,max){
  try{return await consume({scope,identity,max,windowMs:ABUSE_WINDOW_MS,countBeforeRecord:true});}
  catch(error){console.warn('Límite persistente no disponible:',error.message);return{allowed:true,retryAfter:3600};}
}

async function resolveOfficialRate(clientRate){
  const supplied=Number(clientRate||0);
  const stored=await loadLastGood().catch(()=>null);
  const official=Number(stored?.rate||0);
  if(official>0)return{rate:official,source:stored?.source||'BCV persistida',clientRate:supplied>0?supplied:null,adjusted:supplied>0&&Math.abs(supplied-official)/official>0.01};
  if(supplied>0&&supplied<1000000)return{rate:supplied,source:'BCV recibida del portal',clientRate:supplied,adjusted:false};
  return{rate:0,source:'No disponible',clientRate:supplied>0?supplied:null,adjusted:false};
}

async function loadRecentReports(){
  const params=new URLSearchParams({pageSize:'100',filterByFormula:`IS_AFTER(CREATED_TIME(),DATEADD(NOW(),-10,'minutes'))`});
  ['Propietario que Reporta','Forma de Pago Reportada','Equivalente USD Reportado','Monto Reportado','Referencia'].forEach(field=>params.append('fields[]',field));
  let records=[],offset=null;
  do{
    if(offset)params.set('offset',offset);else params.delete('offset');
    const response=await fetch(airtableUrl(TABLES.reportes,`?${params.toString()}`),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||'Error verificando reportes recientes.');
    records=records.concat(data.records||[]);offset=data.offset;
  }while(offset);
  return records;
}

async function findRecentDuplicate({ownerId,mode,amountUsdRef,reference}){
  const normalizedReference=normalizeReference(reference),cutoff=Date.now()-DUPLICATE_WINDOW_MS,reports=await loadRecentReports();
  return reports.find(report=>{const fields=report.fields||{},owners=fields['Propietario que Reporta']||[],createdAt=Date.parse(report.createdTime||''),reportMode=String(fields['Forma de Pago Reportada']||''),reportAmount=money(Number(fields['Equivalente USD Reportado']||fields['Monto Reportado']||0)),reportReference=normalizeReference(fields.Referencia||'');return Array.isArray(owners)&&owners.includes(ownerId)&&reportMode===mode&&Math.abs(reportAmount-amountUsdRef)<=0.01&&reportReference===normalizedReference&&Number.isFinite(createdAt)&&createdAt>=cutoff;})||null;
}

async function listProofCandidates(tableName,{includeVisual=false}={}){
  const formula=includeVisual?`OR({Hash SHA-256}!='',{Hash Perceptual}!='')`:`{Hash SHA-256}!=''`,params=new URLSearchParams({pageSize:'100',filterByFormula:formula});
  ['Hash SHA-256',...(includeVisual?['Hash Perceptual']:[])].forEach(field=>params.append('fields[]',field));
  let records=[],offset=null;
  do{
    if(offset)params.set('offset',offset);else params.delete('offset');
    const response=await fetch(airtableUrl(tableName,`?${params.toString()}`),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}}),data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||'Error verificando comprobantes previos.');
    records=records.concat(data.records||[]);offset=data.offset;
  }while(offset);
  return records;
}

async function findHistoricalFileDuplicate(identity){
  const [reports,payments]=await Promise.all([listProofCandidates(TABLES.reportes,{includeVisual:true}),listProofCandidates(TABLES.pagos,{includeVisual:true})]);
  return findDuplicateMatches({exactSha:identity.sha256,visualHash:identity.visualHash},{reports,payments});
}

async function notifyAdminPaymentReport({ownerId,owner,mode,enteredCurrency,amountEntered,usdEq,amountBs,reference,rateInfo,reportId,access,bank,transactionDate,transactionDateSource,transactionDateConfidence,transactionDateNeedsReview,transactionDateEvidence,transactionStatus,observations,analysisSummary={},attachment,paymentChannel='DIGITAL',cashReceiver='',submissionId=''}){
  const to=process.env.ADMIN_NOTIFY_EMAIL||process.env.SMTP_USER||process.env.ADMIN_RECOVERY_EMAIL;if(!to)return{sent:false,status:'Sin correo administrador configurado'};
  if(!owner)try{owner=await airtableGetRecord(TABLES.propietarios,ownerId)}catch(_){owner=null;}
  const f=owner?.fields||{},casaRaw=cleanPlainText(f.Casa||'—',30),ownerRaw=cleanPlainText(f.Propietario||'Propietario',160),referenceRaw=sanitizeReference(reference)||'N/A';
  const accessRaw=access?.estado?`${cleanPlainText(access.estado,40)}${access.temporary?' temporal':''}`:(access?.skipped?cleanPlainText(access.reason,300):'Sin información');
  const accountText=mode==='USD'?'Deuda/cuenta pagadera en USD':'Deuda/cuenta pagadera en Bs a tasa BCV';
  const enteredText=enteredCurrency==='BS'?fmtBs(amountEntered):fmtUsd(amountEntered);
  const bankText=paymentChannel==='CASH'?'Efectivo':bank||'No indicado',observationsText=observations||'Sin observaciones',channelText=paymentChannel==='CASH'?`Efectivo entregado a ${cashReceiver}`:'Pago digital con comprobante';
  const targetBsText=mode==='Bs BCV'&&rateInfo.rate?`<p><b>Equivalente para la cuenta Bs:</b> ${escapeHtml(fmtBs(amountBs))}</p>`:'';
  const rateText=rateInfo.rate?`<p><b>Tasa BCV aplicada:</b> ${escapeHtml(money(rateInfo.rate).toFixed(2))} Bs/USD (${escapeHtml(rateInfo.source)})${rateInfo.adjusted?' · Se sustituyó una tasa distinta enviada por el navegador.':''}</p>`:'';
  const attachmentText=attachment?`<p><b>Comprobante:</b> ${escapeHtml(attachment.filename)} (${Math.ceil(attachment.size/1024)} KB), adjunto a este correo.</p>`:'<p><b>Comprobante:</b> No adjuntado.</p>';
  const intelligenceText=paymentChannel==='DIGITAL'?`<div style="background:#fff7ed;border:1px solid #fdba74;border-radius:12px;padding:12px;margin:12px 0"><p><b>Lectura inteligente:</b> ${analysisSummary.prefillComplete?'completó los datos principales':'necesitó apoyo en datos principales'}</p><p><b>Proveedor/modelo:</b> ${escapeHtml(analysisSummary.provider||'No informado')} · ruta ${escapeHtml(analysisSummary.route||'no informada')}</p><p><b>Confianza de lectura:</b> ${escapeHtml(String(Math.round((analysisSummary.confidence||0)*100)))}%</p><p><b>Hora visible:</b> ${escapeHtml(analysisSummary.transactionTime||'No detectada')}</p><p><b>Estado visible:</b> ${escapeHtml(analysisSummary.transactionStatus||'No detectado')}</p><p><b>Receptor visible:</b> ${escapeHtml(analysisSummary.recipient||'No detectado')}</p><p><b>Posible modificación visual:</b> ${analysisSummary.possibleVisualModification?'SÍ · revisión prioritaria':'No señalada por la prelectura'}</p><p><b>Advertencias:</b> ${escapeHtml(analysisSummary.warnings.join(' · ')||'Ninguna')}</p><p><b>Datos que requirieron apoyo:</b> ${escapeHtml(analysisSummary.missingLabels.join(' · ')||'Ninguno')}</p></div>`:'';
  return sendMail({
    to,
    subject:`🚨 ${paymentChannel==='CASH'?'Efectivo':'Pago'} reportado - Casa ${casaRaw} - ${fmtUsd(usdEq)} ref.`,
    attachments:attachment?[{filename:attachment.filename,content:attachment.content,contentType:attachment.contentType}]:[],
    html:`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2 style="margin:0 0 10px;color:#0f3d24">🚨 Nuevo pago reportado</h2><p>Se recibió un reporte desde el Portal del Propietario.</p><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:14px;margin:14px 0"><p><b>Casa:</b> ${escapeHtml(casaRaw)}</p><p><b>Propietario:</b> ${escapeHtml(ownerRaw)}</p><p><b>Canal:</b> ${escapeHtml(channelText)}</p><p><b>Cuenta seleccionada:</b> ${escapeHtml(accountText)}</p><p><b>Monto escrito por el propietario:</b> ${escapeHtml(enteredText)}</p><p><b>Equivalente USD referencial:</b> ${escapeHtml(fmtUsd(usdEq))}</p>${targetBsText}${rateText}<p><b>Referencia:</b> ${escapeHtml(referenceRaw)}</p><p><b>Banco o método:</b> ${escapeHtml(bankText)}</p><p><b>Fecha usada:</b> ${escapeHtml(transactionDate)}</p><p><b>Origen de fecha:</b> ${escapeHtml(dateSourceLabel(transactionDateSource))} · ${escapeHtml(transactionDateSource)}</p><p><b>Confianza de fecha:</b> ${escapeHtml(transactionDateConfidence)} · ${transactionDateNeedsReview?'REQUIERE CONTRASTE':'detectada directamente'}</p><p><b>Evidencia de fecha:</b> ${escapeHtml(transactionDateEvidence)}</p><p><b>Estado interno inicial:</b> ${escapeHtml(transactionStatus)}</p><p><b>Observaciones:</b> ${escapeHtml(observationsText)}</p>${attachmentText}${intelligenceText}<p><b>Fecha automática:</b> ${escapeHtml(nowCaracasLabel())}</p><p><b>Reporte:</b> ${escapeHtml(reportId||'—')}</p><p><b>ID de envío:</b> ${escapeHtml(submissionId||'—')}</p><p><b>Portón:</b> ${escapeHtml(accessRaw)}</p></div><p><a href="https://villalosapamates.netlify.app/admin.html" style="display:inline-block;background:#0f3d24;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Admin VLA</a></p></div>`
  });
}

async function attachmentIdentity(attachment){
  const sha256=crypto.createHash('sha256').update(attachment.content).digest('hex'),visual=await computePerceptualHash(attachment.content,attachment.contentType);
  return{sha256,visualHash:visual.hash||'',visualAlgorithm:visual.algorithm||'none'};
}
async function storeEncryptedProof(scopeId,attachment,identity,proofStore=createProofStore()){
  if(!attachment)return null;
  const resolvedIdentity=identity||await attachmentIdentity(attachment);
  const stored=await proofStore.put({reportId:scopeId,content:attachment.content,contentType:attachment.contentType,attachmentSha:resolvedIdentity.sha256}),verified=await proofStore.getByKey({key:stored.key,attachmentSha:resolvedIdentity.sha256,contentType:attachment.contentType});
  if(!verified||!verified.content.equals(attachment.content))throw Object.assign(new Error('No se pudo verificar el comprobante cifrado después de guardarlo.'),{code:'PROOF_STORAGE_VERIFY_FAILED'});
  return{...stored,...resolvedIdentity,verified:true};
}
async function triggerBackgroundAnalysis(reportId){
  const siteUrl=String(process.env.URL||process.env.DEPLOY_PRIME_URL||'').replace(/\/$/,'');if(!siteUrl)return{queued:false,status:'SITE_URL_MISSING'};
  const payload=JSON.stringify({reportId}),authorization=sign(payload);
  const response=await fetch(`${siteUrl}/api/vla/payment-report-analyzer`,{method:'POST',headers:{'Content-Type':'application/json','x-vla-job-timestamp':authorization.timestamp,'x-vla-job-signature':authorization.signature},body:payload});
  return{queued:response.ok,status:response.status};
}

const handler = async function(event){
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  let auditContext={event:'VLA_PAYMENT_REPORT_FAILED'};
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});
  try{
    const body=JSON.parse(event.body||'{}');
    const ownerId=String(body.ownerId||'').trim(),mode=String(body.mode||'').trim(),enteredCurrency=String(body.enteredCurrency||'').trim().toUpperCase(),paymentChannel=String(body.paymentChannel||'DIGITAL').trim().toUpperCase(),rawReference=sanitizeReference(body.reference),amount=parseAmountInput(body.amount),ip=clientIp(event);
    const cashReceiver=optionalText(body.cashReceiver,120),reportedBank=optionalText(body.bank,100),bank=paymentChannel==='CASH'?'Efectivo':reportedBank,method=paymentChannel==='CASH'?'CASH':normalizePaymentMethod(body.method,reportedBank),clientTransactionDate=String(body.transactionDate||'').trim(),transactionStatus=paymentChannel==='CASH'?'PENDING_ADMIN_CONFIRMATION':'PENDING_REVIEW',observations=optionalText(body.observations,300),analysisSummary=normalizeAnalysisSummary(body.analysisSummary),reportTimestamp=new Date().toISOString();
    const submissionId=/^[A-Za-z0-9_-]{8,100}$/.test(String(body.submissionId||''))?String(body.submissionId):crypto.randomUUID();
    const dateResolution=resolveSubmittedDate({clientDate:clientTransactionDate,clientSource:body.transactionDateSource,attachment:body.attachment,paymentChannel}),{transactionDate,transactionDateSource,transactionDateConfidence,transactionDateNeedsReview,transactionDateEvidence}=dateResolution;
    auditContext={event:'VLA_PAYMENT_REPORT_FAILED',ownerId,paymentChannel,method,submissionId};
    if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
    if(!PAYMENT_CHANNELS.has(paymentChannel))return json(400,{message:'Seleccione si el pago fue digital o en efectivo.'});
    if(!ALLOWED_MODES.has(mode))return json(400,{message:'Seleccione la deuda o cuenta que está pagando.'});
    if(!ALLOWED_ENTERED_CURRENCIES.has(enteredCurrency))return json(400,{message:'Debe confirmar si escribió el monto en dólares o bolívares.'});
    if(!(amount>0)||amount>1000000000)return json(400,{message:'Monto inválido.'});
    if(paymentChannel==='DIGITAL'&&!rawReference)return json(400,{message:'Debe indicar referencia o confirmación.'});
    if(paymentChannel==='DIGITAL'&&!reportedBank)return json(400,{message:'Debe indicar el banco o método de pago.'});
    if(paymentChannel==='CASH'&&cashReceiver.length<2)return json(400,{message:'Indique a quién o dónde entregó el efectivo.'});
    const attachment=paymentChannel==='DIGITAL'?decodeAttachment(body.attachment):null;
    if(paymentChannel==='DIGITAL'&&!attachment)return json(400,{message:'Debe adjuntar el comprobante antes de enviar el reporte.'});
    if(paymentChannel==='DIGITAL')connectLambdaEvent(event);
    const reference=rawReference||(paymentChannel==='CASH'?`EFECTIVO · ${cashReceiver} · ${transactionDate}`:'');

    const [ipLimit,ownerLimit]=await Promise.all([rateLimit('PUBLIC_REPORT_IP',ip,MAX_REPORTS_PER_IP),rateLimit('PUBLIC_REPORT_OWNER',ownerId,MAX_REPORTS_PER_OWNER)]);
    if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{success:false,protected:true,message:'Se alcanzó el límite temporal de reportes. Espere antes de intentar nuevamente.'},{'Retry-After':String(retryAfter)});}

    const rateInfo=await resolveOfficialRate(body.rate);
    if((mode==='Bs BCV'||enteredCurrency==='BS')&&!(rateInfo.rate>0))return json(400,{message:'La tasa BCV no está disponible. Intente nuevamente más tarde.'});
    const resolved=resolveAmount({amount,enteredCurrency,rate:rateInfo.rate});
    if(!resolved.ok||!(resolved.amountUsdRef>0)||resolved.amountUsdRef>1000000)return json(400,{message:'El monto convertido no es válido.'});
    const usdEq=money(resolved.amountUsdRef),amountBs=mode==='Bs BCV'?money(usdEq*rateInfo.rate):(enteredCurrency==='BS'?money(amount):0);
    const owner=await airtableGetRecord(TABLES.propietarios,ownerId);
    const ownerFields=owner?.fields||{};

    const duplicate=await findRecentDuplicate({ownerId,mode,amountUsdRef:usdEq,reference});
    if(duplicate)return json(409,{success:false,duplicate:true,retryAfterSeconds:300,message:'Este pago ya fue reportado recientemente. La administración se encuentra verificándolo. Espere al menos 5 minutos antes de intentar nuevamente.'},{'Retry-After':'300'});

    let proof=null,identity=null,identityReservation=null,proofStore=null;
    if(paymentChannel==='DIGITAL'){
      identity=await attachmentIdentity(attachment);
      const historicalDuplicate=await findHistoricalFileDuplicate(identity);
      if(historicalDuplicate.isDuplicate)return json(409,{success:false,duplicate:true,duplicateType:historicalDuplicate.type,message:'Este comprobante ya fue utilizado en un reporte o pago anterior. No se creó un reporte nuevo.'});
      proofStore=createProofStore();
      identityReservation=await proofStore.reserveIdentity({attachmentSha:identity.sha256,requestId:submissionId,ownerId});
      if(identityReservation.idempotent)return json(200,{success:true,idempotent:true,reportId:identityReservation.reportId,message:'Este reporte ya había sido recibido correctamente. No se creó un duplicado.'});
      if(!identityReservation.acquired)return json(409,{success:false,duplicate:true,duplicateType:'Hash exacto en proceso',message:'Este comprobante ya está siendo procesado o fue usado anteriormente. No se creó un reporte nuevo.'});
      proof=await storeEncryptedProof(`upload-${identity.sha256}`,attachment,identity,proofStore);
    }

    const reportContext=[`Canal reportado: ${paymentChannel==='CASH'?'EFECTIVO':'DIGITAL'}`,paymentChannel==='CASH'?`Efectivo entregado a: ${cashReceiver}`:'',`Método detectado/confirmado: ${method}`,`Fecha usada por el portal: ${transactionDate}`,`Fuente de fecha: ${transactionDateSource} (${dateSourceLabel(transactionDateSource)})`,`Confianza de fecha: ${transactionDateConfidence}`,`Fecha requiere contraste: ${transactionDateNeedsReview?'SÍ':'NO'}`,`Evidencia de fecha: ${transactionDateEvidence}`,`Estado interno inicial: ${transactionStatus}`,paymentChannel==='DIGITAL'?`Prelectura completa: ${analysisSummary.prefillComplete?'SÍ':'NO'}`:'',analysisSummary.provider?`Proveedor/modelo de prelectura: ${analysisSummary.provider}`:'',analysisSummary.route?`Ruta de prelectura: ${analysisSummary.route}`:'',paymentChannel==='DIGITAL'?`Confianza de prelectura: ${Math.round(analysisSummary.confidence*100)}%`:'',analysisSummary.transactionTime?`Hora visible detectada: ${analysisSummary.transactionTime}`:'',analysisSummary.transactionStatus?`Estado visible detectado: ${analysisSummary.transactionStatus}`:'',analysisSummary.recipient?`Receptor visible detectado: ${analysisSummary.recipient}`:'',paymentChannel==='DIGITAL'?`Posible modificación visual: ${analysisSummary.possibleVisualModification?'SÍ':'NO señalada'}`:'',analysisSummary.warnings.length?`Advertencias de prelectura: ${analysisSummary.warnings.join(' · ')}`:'',analysisSummary.missingLabels.length?`Datos que requirieron apoyo: ${analysisSummary.missingLabels.join(' · ')}`:'',`ID de envío: ${submissionId}`,observations].filter(Boolean).join('\n');
    const fields={'Propietario que Reporta':[ownerId],'Monto Reportado':usdEq,Referencia:reference,Estado:'Pendiente','Fecha del Reporte':todayCaracasISO(),'Forma de Pago Reportada':mode,'Equivalente USD Reportado':usdEq,'Estado Acceso al Reportar':String(ownerFields['Estado Acceso Portón']||'Sin configurar'),'Casa al Reportar':Number(ownerFields.Casa||0),'Fecha y Hora del Reporte':reportTimestamp,'Moneda Ingresada':enteredCurrency==='BS'?'VES':'USD','Monto Ingresado':amount,'Fuente Tasa BCV Reporte':rateInfo.source,'Archivo Obligatorio':paymentChannel==='DIGITAL','Estado de Procesamiento':paymentChannel==='CASH'?'Pendiente de administrador':'Recibido','Resultado Validación':paymentChannel==='CASH'?'Revisión manual urgente':'Pendiente','Decisión Administrativa':'Pendiente','Banco Reportado':bank,'Observaciones Reportadas':reportContext};
    if(proof){Object.assign(fields,{'Comprobante Blob Key':proof.key,'Comprobante Nombre Original':attachment.filename,'Comprobante MIME':attachment.contentType,'Comprobante Bytes':attachment.size,'Hash SHA-256':identity.sha256,'Hash Perceptual':identity.visualHash});}
    if(mode==='Bs BCV'){fields['Monto Reportado Bs']=amountBs;fields['Tasa BCV Reporte']=rateInfo.rate;}
    const report=await airtableCreateRecord(TABLES.reportes,fields);
    if(identityReservation)await proofStore.completeIdentity({reservation:identityReservation,reportId:report.id}).catch(error=>console.warn('No se pudo completar la reserva idempotente:',error.message));
    const access=pendingReportAccessDecision(report?.id);
    const automationTask=paymentChannel==='CASH'?Promise.resolve({queued:false,status:'CASH_ADMIN_CONFIRMATION_REQUIRED'}):triggerBackgroundAnalysis(report.id).catch(error=>({queued:false,status:safeDisplayText(error.code||error.message,160)}));
    const notificationTask=notifyAdminPaymentReport({ownerId,owner,mode,enteredCurrency,amountEntered:amount,usdEq,amountBs,reference,rateInfo,reportId:report?.id,access,bank,transactionDate,transactionDateSource,transactionDateConfidence,transactionDateNeedsReview,transactionDateEvidence,transactionStatus,observations,analysisSummary,attachment,paymentChannel,cashReceiver,submissionId}).catch(error=>({sent:false,status:'Error enviando notificación admin',detail:safeDisplayText(error.message,500)}));
    const [automation,adminNotification]=await Promise.all([within(automationTask,POST_CREATE_TIMEOUT_MS,{queued:false,status:'BACKGROUND_TRIGGER_TIMEOUT'}),within(notificationTask,POST_CREATE_TIMEOUT_MS,{sent:false,status:'Notificación diferida para proteger la respuesta del portal'})]);
    const message=paymentChannel==='CASH'?'Efectivo reportado. Quedó pendiente de confirmación administrativa; no se modificará el saldo ni el acceso hasta que la entrega sea verificada.':automation.queued?'Pago recibido. El motor inteligente está validando el comprobante, el receptor y posibles duplicados.':'Pago recibido y protegido. La validación se reintentará automáticamente.';
    console.info(JSON.stringify({event:'VLA_PAYMENT_REPORT_CREATED',reportId:report?.id||null,ownerId,paymentChannel,method,submissionId,transactionDateSource,targetMode:mode,proofStored:Boolean(proof?.verified),analysisQueued:Boolean(automation.queued)}));
    return json(200,deepEscapeStrings({success:true,message,reportId:report?.id,paymentChannel,targetMode:mode,enteredCurrency,amountEntered:amount,amountUsdRef:usdEq,amountBs,rateApplied:rateInfo.rate||null,method,transactionDate,transactionDateSource,transactionDateConfidence,transactionDateNeedsReview,transactionDateEvidence,reportTimestamp,attachmentIncluded:Boolean(attachment),proofStored:Boolean(proof?.verified),visualHashStored:Boolean(identity?.visualHash),automation,access,adminNotification}));
  }catch(error){
    console.error(JSON.stringify({...auditContext,errorCode:safeDisplayText(error.code||error.name||'UNKNOWN',120)}));
    const clientError=/adjunto|formato no permitido|no coincide con su formato|3 MB|datos inválidos|archivo vacío/i.test(String(error.message||''));
    return json(clientError?400:503,{message:clientError?'No se pudo procesar el comprobante. No se creó ningún reporte.':'El almacenamiento seguro no está disponible. No se creó ningún reporte; intente nuevamente.',detail:safeDisplayText(error.code||error.message,500)});
  }
};

exports.handler = withAirtableUsage('public-report-payment', handler);
exports.pendingReportAccessDecision = pendingReportAccessDecision;
exports.storeEncryptedProof = storeEncryptedProof;
exports.triggerBackgroundAnalysis = triggerBackgroundAnalysis;
exports.attachmentIdentity = attachmentIdentity;
exports.findHistoricalFileDuplicate = findHistoricalFileDuplicate;
exports.normalizePaymentMethod = normalizePaymentMethod;
exports.normalizeAnalysisSummary = normalizeAnalysisSummary;
