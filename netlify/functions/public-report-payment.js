// netlify/functions/public-report-payment.js
// Reporte público protegido: moneda objetivo separada, detección de moneda escrita,
// deduplicación, límites persistentes y notificación administrativa con comprobante opcional.

'use strict';

const { withAirtableUsage } = require('./_airtable_meter');
const { airtableCreateRecord, airtableGetRecord, TABLES, money } = require('./_access_control');
const { sendMail } = require('./_mailer');
const { sanitizeReference, escapeHtml, cleanPlainText, safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const { consume } = require('./_persistent_rate_limit');
const { loadLastGood } = require('./_bcv_store');
const { parseAmountInput, resolveAmount } = require('../../payment-report-intelligence');
const { decodeAttachment } = require('./_payment_report_attachment');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
const ALLOWED_ENTERED_CURRENCIES = new Set(['USD', 'BS']);
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const ABUSE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REPORTS_PER_IP = 12;
const MAX_REPORTS_PER_OWNER = 6;

function todayCaracasISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function nowCaracasLabel(){return new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}
function fmtUsd(n){return '$'+money(n).toFixed(2);}
function fmtBs(n){return 'Bs. '+money(n).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2});}
function normalizeReference(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();}
function optionalText(value,max){return cleanPlainText(String(value||''),max).trim();}
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)};}
function airtableUrl(tableName,query=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`;}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120);}
function pendingReportAccessDecision(reportId){return{reportId:String(reportId||'').trim()||null,skipped:true,action:'pending-review',temporary:false,reason:'Un reporte pendiente no modifica el portón. La administración debe revisarlo antes de cualquier decisión de acceso.'};}

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

async function notifyAdminPaymentReport({ownerId,mode,enteredCurrency,amountEntered,usdEq,amountBs,reference,rateInfo,reportId,access,bank,observations,attachment}){
  const to=process.env.ADMIN_NOTIFY_EMAIL||process.env.SMTP_USER||process.env.ADMIN_RECOVERY_EMAIL;if(!to)return{sent:false,status:'Sin correo administrador configurado'};
  let owner=null;try{owner=await airtableGetRecord(TABLES.propietarios,ownerId)}catch(_){owner=null;}
  const f=owner?.fields||{},casaRaw=cleanPlainText(f.Casa||'—',30),ownerRaw=cleanPlainText(f.Propietario||'Propietario',160),referenceRaw=sanitizeReference(reference)||'N/A';
  const accessRaw=access?.estado?`${cleanPlainText(access.estado,40)}${access.temporary?' temporal':''}`:(access?.skipped?cleanPlainText(access.reason,300):'Sin información');
  const accountText=mode==='USD'?'Deuda/cuenta pagadera en USD':'Deuda/cuenta pagadera en Bs a tasa BCV';
  const enteredText=enteredCurrency==='BS'?fmtBs(amountEntered):fmtUsd(amountEntered);
  const bankText=bank||'No indicado',observationsText=observations||'Sin observaciones';
  const targetBsText=mode==='Bs BCV'&&rateInfo.rate?`<p><b>Equivalente para la cuenta Bs:</b> ${escapeHtml(fmtBs(amountBs))}</p>`:'';
  const rateText=rateInfo.rate?`<p><b>Tasa BCV aplicada:</b> ${escapeHtml(money(rateInfo.rate).toFixed(2))} Bs/USD (${escapeHtml(rateInfo.source)})${rateInfo.adjusted?' · Se sustituyó una tasa distinta enviada por el navegador.':''}</p>`:'';
  const attachmentText=attachment?`<p><b>Comprobante:</b> ${escapeHtml(attachment.filename)} (${Math.ceil(attachment.size/1024)} KB), adjunto a este correo.</p>`:'<p><b>Comprobante:</b> No adjuntado.</p>';
  return sendMail({
    to,
    subject:`🚨 Pago reportado - Casa ${casaRaw} - ${fmtUsd(usdEq)} ref.`,
    attachments:attachment?[{filename:attachment.filename,content:attachment.content,contentType:attachment.contentType}]:[],
    html:`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2 style="margin:0 0 10px;color:#0f3d24">🚨 Nuevo pago reportado</h2><p>Se recibió un reporte desde el Portal del Propietario.</p><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:14px;margin:14px 0"><p><b>Casa:</b> ${escapeHtml(casaRaw)}</p><p><b>Propietario:</b> ${escapeHtml(ownerRaw)}</p><p><b>Cuenta seleccionada:</b> ${escapeHtml(accountText)}</p><p><b>Monto escrito por el propietario:</b> ${escapeHtml(enteredText)}</p><p><b>Equivalente USD referencial:</b> ${escapeHtml(fmtUsd(usdEq))}</p>${targetBsText}${rateText}<p><b>Referencia:</b> ${escapeHtml(referenceRaw)}</p><p><b>Banco o método:</b> ${escapeHtml(bankText)}</p><p><b>Observaciones:</b> ${escapeHtml(observationsText)}</p>${attachmentText}<p><b>Fecha automática:</b> ${escapeHtml(nowCaracasLabel())}</p><p><b>Reporte:</b> ${escapeHtml(reportId||'—')}</p><p><b>Portón:</b> ${escapeHtml(accessRaw)}</p></div><p><a href="https://villalosapamates.netlify.app/admin.html" style="display:inline-block;background:#0f3d24;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Admin VLA</a></p></div>`
  });
}

const handler = async function(event){
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});
  try{
    const body=JSON.parse(event.body||'{}');
    const ownerId=String(body.ownerId||'').trim(),mode=String(body.mode||'').trim(),enteredCurrency=String(body.enteredCurrency||'').trim().toUpperCase(),reference=sanitizeReference(body.reference),amount=parseAmountInput(body.amount),ip=clientIp(event);
    const bank=optionalText(body.bank,100),observations=optionalText(body.observations,300);
    if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
    if(!ALLOWED_MODES.has(mode))return json(400,{message:'Seleccione la deuda o cuenta que está pagando.'});
    if(!ALLOWED_ENTERED_CURRENCIES.has(enteredCurrency))return json(400,{message:'Debe confirmar si escribió el monto en dólares o bolívares.'});
    if(!(amount>0)||amount>1000000000)return json(400,{message:'Monto inválido.'});
    if(!reference)return json(400,{message:'Debe indicar referencia o confirmación.'});

    const [ipLimit,ownerLimit]=await Promise.all([rateLimit('PUBLIC_REPORT_IP',ip,MAX_REPORTS_PER_IP),rateLimit('PUBLIC_REPORT_OWNER',ownerId,MAX_REPORTS_PER_OWNER)]);
    if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{success:false,protected:true,message:'Se alcanzó el límite temporal de reportes. Espere antes de intentar nuevamente.'},{'Retry-After':String(retryAfter)});}

    const rateInfo=await resolveOfficialRate(body.rate);
    if((mode==='Bs BCV'||enteredCurrency==='BS')&&!(rateInfo.rate>0))return json(400,{message:'La tasa BCV no está disponible. Intente nuevamente más tarde.'});
    const resolved=resolveAmount({amount,enteredCurrency,rate:rateInfo.rate});
    if(!resolved.ok||!(resolved.amountUsdRef>0)||resolved.amountUsdRef>1000000)return json(400,{message:'El monto convertido no es válido.'});
    const usdEq=money(resolved.amountUsdRef),amountBs=mode==='Bs BCV'?money(usdEq*rateInfo.rate):(enteredCurrency==='BS'?money(amount):0);
    const attachment=decodeAttachment(body.attachment);

    const duplicate=await findRecentDuplicate({ownerId,mode,amountUsdRef:usdEq,reference});
    if(duplicate)return json(409,{success:false,duplicate:true,retryAfterSeconds:300,message:'Este pago ya fue reportado recientemente. La administración se encuentra verificándolo. Espere al menos 5 minutos antes de intentar nuevamente.'},{'Retry-After':'300'});

    const fields={'Propietario que Reporta':[ownerId],'Monto Reportado':usdEq,Referencia:reference,Estado:'Pendiente','Fecha del Reporte':todayCaracasISO(),'Forma de Pago Reportada':mode,'Equivalente USD Reportado':usdEq};
    if(mode==='Bs BCV'){fields['Monto Reportado Bs']=amountBs;fields['Tasa BCV Reporte']=rateInfo.rate;}
    const report=await airtableCreateRecord(TABLES.reportes,fields);
    const access=pendingReportAccessDecision(report?.id);
    let adminNotification=null;try{adminNotification=await notifyAdminPaymentReport({ownerId,mode,enteredCurrency,amountEntered:amount,usdEq,amountBs,reference,rateInfo,reportId:report?.id,access,bank,observations,attachment});}catch(error){adminNotification={sent:false,status:'Error enviando notificación admin',detail:safeDisplayText(error.message,500)};}
    return json(200,deepEscapeStrings({success:true,message:'Pago reportado correctamente. La administración verificará la información en un plazo no mayor de 72 horas.',reportId:report?.id,targetMode:mode,enteredCurrency,amountEntered:amount,amountUsdRef:usdEq,amountBs,rateApplied:rateInfo.rate||null,attachmentIncluded:Boolean(attachment),access,adminNotification}));
  }catch(error){
    const clientError=/comprobante|adjunto|formato|3 MB|datos inválidos/i.test(String(error.message||''));
    return json(clientError?400:500,{message:clientError?'No se pudo procesar el comprobante.':'Error guardando reporte.',detail:safeDisplayText(error.message,500)});
  }
};

exports.handler = withAirtableUsage('public-report-payment', handler);
exports.pendingReportAccessDecision = pendingReportAccessDecision;
