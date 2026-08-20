'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {airtableGetRecord,airtableListAll,TABLES}=require('./_shared/_access_control');
const {consume}=require('./_shared/_persistent_rate_limit');
const tracking=require('./_shared/_payment_report_tracking');
const ownerSession=require('./_shared/_owner_report_session');

const MAX_REPORTS=12;
function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function allowed(identity){try{return await consume({scope:'PAYMENT_TRACKING_STATUS',identity,max:120,windowMs:60*60*1000,countBeforeRecord:true})}catch(error){console.warn('Límite de seguimiento no disponible:',error.message);return{allowed:true,retryAfter:60}}}
async function authorizedReport(ownerId,credential){
 if(!tracking.validRecordId(credential?.reportId)||!tracking.TOKEN_PATTERN.test(String(credential?.token||'')))return null;
 const report=await airtableGetRecord(TABLES.reportes,credential.reportId).catch(()=>null),fields=report?.fields||{};
 if(!report||!tracking.ownerMatches(fields,ownerId)||!tracking.verifyTrackingToken(credential.token,fields['Tracking Token Hash']))return null;
 return report;
}
function reportTime(record){
 const fields=record?.fields||{},value=fields['Fecha y Hora del Reporte']||fields['Fecha del Reporte']||'';
 const parsed=Date.parse(String(value||''));return Number.isFinite(parsed)?parsed:0;
}
async function sessionReports(ownerId){
 const records=await airtableListAll(TABLES.reportes);
 return records.filter(record=>tracking.ownerMatches(record?.fields||{},ownerId)).sort((a,b)=>reportTime(b)-reportTime(a)).slice(0,MAX_REPORTS);
}
async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return json(500,{message:'El seguimiento no está configurado.'});
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return json(400,{message:'Solicitud inválida.'})}
 const ownerId=String(body.ownerId||'').trim(),credentials=Array.isArray(body.reports)?body.reports.slice(0,MAX_REPORTS):[];
 if(!tracking.validRecordId(ownerId))return json(400,{message:'Propietario inválido para consultar reportes.'});
 const limit=await allowed(`${clientIp(event)}|${ownerId}`);if(!limit.allowed)return json(429,{message:'Espera un momento antes de volver a actualizar.'},{'Retry-After':String(limit.retryAfter||60)});

 const session=ownerSession.sessionFromEvent(event,ownerId);
 if(session){
  const records=await sessionReports(ownerId);
  return json(200,{success:true,authorization:'verified-device',reports:records.map(tracking.sanitizeReport)});
 }
 if(!credentials.length)return json(401,{message:'Verifica esta casa una vez para sincronizar Mis reportes en este dispositivo.',verificationRequired:true});
 const records=await Promise.all(credentials.map(item=>authorizedReport(ownerId,item))),reports=records.filter(Boolean).map(tracking.sanitizeReport);
 return json(200,{success:true,authorization:'legacy-device',reports});
}

exports.handler=withAirtableUsage('public-payment-report-status',handler);
exports.authorizedReport=authorizedReport;
exports.sessionReports=sessionReports;
exports.MAX_REPORTS=MAX_REPORTS;
