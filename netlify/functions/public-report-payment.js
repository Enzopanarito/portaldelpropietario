// netlify/functions/public-report-payment.js
// Reporte público protegido: deduplicación, límites persistentes y notificación administrativa.

'use strict';

const { airtableCreateRecord, airtableGetRecord, syncOwnerAccess, TABLES, money } = require('./_access_control');
const { sendMail } = require('./_mailer');
const { sanitizeReference, escapeHtml, cleanPlainText, safeDisplayText, deepEscapeStrings } = require('./_security_utils');
const { consume } = require('./_persistent_rate_limit');
const { begin, setState } = require('./_operation_guard');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
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
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)};}
function airtableUrl(tableName,query=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`;}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120);}

async function rateLimit(scope,identity,max){
  try{return await consume({scope,identity,max,windowMs:ABUSE_WINDOW_MS,countBeforeRecord:true});}
  catch(error){console.warn('Límite persistente no disponible:',error.message);return{allowed:true,retryAfter:3600};}
}
async function loadRecentReports(){
  const formula=encodeURIComponent("IS_AFTER(CREATED_TIME(),DATEADD(NOW(),-10,'minutes'))");
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
async function findRecentDuplicate({ownerId,mode,amount,reference}){
  const normalizedReference=normalizeReference(reference),cutoff=Date.now()-DUPLICATE_WINDOW_MS,reports=await loadRecentReports();
  return reports.find(report=>{const fields=report.fields||{},owners=fields['Propietario que Reporta']||[],createdAt=Date.parse(report.createdTime||''),reportMode=String(fields['Forma de Pago Reportada']||''),reportAmount=money(Number(fields['Equivalente USD Reportado']||fields['Monto Reportado']||0)),reportReference=normalizeReference(fields.Referencia||'');return Array.isArray(owners)&&owners.includes(ownerId)&&reportMode===mode&&Math.abs(reportAmount-amount)<=0.01&&reportReference===normalizedReference&&Number.isFinite(createdAt)&&createdAt>=cutoff;})||null;
}
async function notifyAdminPaymentReport({ownerId,mode,amount,usdEq,amountBs,reference,rate,reportId,access}){
  const to=process.env.ADMIN_NOTIFY_EMAIL||process.env.SMTP_USER||process.env.ADMIN_RECOVERY_EMAIL;if(!to)return{sent:false,status:'Sin correo administrador configurado'};
  let owner=null;try{owner=await airtableGetRecord(TABLES.propietarios,ownerId)}catch(_){owner=null}
  const f=owner?.fields||{},casaRaw=cleanPlainText(f.Casa||'—',30),ownerRaw=cleanPlainText(f.Propietario||'Propietario',160),referenceRaw=sanitizeReference(reference)||'N/A';
  const accessRaw=access?.estado?`${cleanPlainText(access.estado,40)}${access.temporary?' temporal':''}`:(access?.skipped?cleanPlainText(access.reason,300):'Sin información');
  const originalAmount=mode==='Bs BCV'?`${fmtUsd(amount)} ref. / ${fmtBs(amountBs||0)}`:fmtUsd(amount);
  const rateText=mode==='Bs BCV'&&rate?`<p><b>Tasa reportada:</b> ${money(rate).toFixed(2)} Bs/USD</p>`:'';
  return sendMail({to,subject:`🚨 Pago reportado - Casa ${casaRaw} - ${fmtUsd(usdEq)} ref.`,html:`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5"><h2 style="margin:0 0 10px;color:#0f3d24">🚨 Nuevo pago reportado</h2><p>Se acaba de recibir un reporte de pago en el portal.</p><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:14px;margin:14px 0"><p><b>Casa:</b> ${escapeHtml(casaRaw)}</p><p><b>Propietario:</b> ${escapeHtml(ownerRaw)}</p><p><b>Forma:</b> ${escapeHtml(mode)}</p><p><b>Monto:</b> ${escapeHtml(originalAmount)}</p><p><b>Equivalente USD:</b> ${escapeHtml(fmtUsd(usdEq))}</p>${rateText}<p><b>Referencia:</b> ${escapeHtml(referenceRaw)}</p><p><b>Fecha:</b> ${escapeHtml(nowCaracasLabel())}</p><p><b>Reporte:</b> ${escapeHtml(reportId||'—')}</p><p><b>Portón:</b> ${escapeHtml(accessRaw)}</p></div><p><a href="https://villalosapamates.netlify.app/admin.html" style="display:inline-block;background:#0f3d24;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Admin VLA</a></p></div>`});
}

exports.handler=async function(event){
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  let operation=null, createdReportId='', operationKey='';
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});
  try{
    const body=JSON.parse(event.body||'{}'),ownerId=String(body.ownerId||'').trim(),mode=String(body.mode||'').trim(),reference=sanitizeReference(body.reference),amount=money(Number(body.amount||0)),rate=Number(body.rate||0),ip=clientIp(event);
    if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
    if(!ALLOWED_MODES.has(mode))return json(400,{message:'Forma de pago inválida.'});
    if(!(amount>0)||amount>1000000)return json(400,{message:'Monto inválido. Ingrese el monto en USD referencial.'});
    if(!reference)return json(400,{message:'Debe indicar referencia.'});
    if(mode==='Bs BCV'&&(!(rate>0)||rate>1000000))return json(400,{message:'La tasa BCV reportada no es válida.'});

    const [ipLimit,ownerLimit]=await Promise.all([rateLimit('PUBLIC_REPORT_IP',ip,MAX_REPORTS_PER_IP),rateLimit('PUBLIC_REPORT_OWNER',ownerId,MAX_REPORTS_PER_OWNER)]);
    if(!ipLimit.allowed||!ownerLimit.allowed){const retryAfter=Math.max(ipLimit.retryAfter||0,ownerLimit.retryAfter||0,60);return json(429,{success:false,protected:true,message:'Se alcanzó el límite temporal de reportes. Espere antes de intentar nuevamente.'},{'Retry-After':String(retryAfter)});}

    const duplicate=await findRecentDuplicate({ownerId,mode,amount,reference});
    if(duplicate)return json(409,{success:false,duplicate:true,retryAfterSeconds:300,message:'Este pago ya fue reportado recientemente. La administración se encuentra verificándolo. Espere al menos 5 minutos antes de intentar nuevamente.'},{'Retry-After':'300'});

    // Bloqueo atómico por propietario, moneda, monto, referencia y ventana de cinco minutos.
    const bucket=Math.floor(Date.now()/DUPLICATE_WINDOW_MS);
    operationKey=`${ownerId}|${mode}|${amount.toFixed(2)}|${normalizeReference(reference)}|${bucket}`;
    const guard=await begin('PUBLIC_PAYMENT_REPORT',operationKey);
    if(!guard.ok)return json(409,{success:false,duplicate:true,protected:true,retryAfterSeconds:300,message:'Este pago ya está siendo reportado o fue recibido recientemente. La administración se encuentra verificándolo.'},{'Retry-After':'300'});
    operation=guard.marker;

    const usdEq=amount,amountBs=mode==='Bs BCV'?money(amount*rate):0;
    const fields={'Propietario que Reporta':[ownerId],'Monto Reportado':usdEq,Referencia:reference,Estado:'Pendiente','Fecha del Reporte':todayCaracasISO(),'Forma de Pago Reportada':mode,'Equivalente USD Reportado':usdEq};
    if(mode==='Bs BCV'){fields['Monto Reportado Bs']=amountBs;fields['Tasa BCV Reporte']=rate;}
    const report=await airtableCreateRecord(TABLES.reportes,fields);
    createdReportId=report?.id||'';
    await setState(operation,'PUBLIC_PAYMENT_REPORT',operationKey,'DONE',createdReportId).catch(error=>console.warn('No se pudo cerrar guard de reporte:',error.message));
    let access=null;try{access=await syncOwnerAccess(ownerId,{reason:'Habilitación temporal por reporte pendiente suficiente para deuda vencida.',sendEmail:false})}catch(error){access={error:safeDisplayText(error.message,500)}}
    let adminNotification=null;try{adminNotification=await notifyAdminPaymentReport({ownerId,mode,amount,usdEq,amountBs,reference,rate,reportId:report?.id,access})}catch(error){adminNotification={sent:false,status:'Error enviando notificación admin',detail:safeDisplayText(error.message,500)}}
    return json(200,deepEscapeStrings({success:true,message:'Pago reportado correctamente. La administración verificará la información en un plazo no mayor de 72 horas.',reportId:report?.id,amountUsdRef:amount,amountBs,access,adminNotification}));
  }catch(error){if(operation&&!createdReportId&&operationKey)await setState(operation,'PUBLIC_PAYMENT_REPORT',operationKey,'ERROR').catch(()=>null);return json(500,{message:'Error guardando reporte.',detail:safeDisplayText(error.message,500)});}
};
