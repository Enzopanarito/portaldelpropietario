'use strict';

const {withAirtableUsage}=require('./_shared/_airtable_meter');
const {airtableGetRecord,TABLES}=require('./_shared/_access_control');
const {consume}=require('./_shared/_persistent_rate_limit');
const {sendMail}=require('./_shared/_mailer');
const ownerSession=require('./_shared/_owner_report_session');

function json(statusCode,body,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(body)}}
function clientIp(event){const h=event.headers||{};return String(h['x-nf-client-connection-ip']||h['X-Nf-Client-Connection-Ip']||h['x-forwarded-for']||h['X-Forwarded-For']||'unknown').split(',')[0].trim().slice(0,120)}
async function limited(scope,identity,max){try{return await consume({scope,identity,max,windowMs:30*60*1000,countBeforeRecord:true})}catch(error){console.error(`${scope} rate limit unavailable:`,error.message);return{allowed:false,unavailable:true,retryAfter:60}}}
function validOwnerId(value){return/^rec[A-Za-z0-9]{14}$/.test(String(value||''))}
function validEmail(value){return/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||'').trim())}
function emailHtml({code,casa}){
 return`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a"><h2 style="margin-bottom:8px">Villa Los Apamates</h2><p>Se solicitó acceso privado a <b>Mis reportes</b> de la Casa ${Number(casa)||''}.</p><p style="font-size:34px;letter-spacing:8px;font-weight:800;margin:28px 0">${code}</p><p>Este código vence en 10 minutos. No lo compartas con otras personas.</p><p style="color:#64748b;font-size:13px">Si no solicitaste este acceso, puedes ignorar este correo. No se modificó ningún saldo ni reporte.</p></div>`;
}
async function requestCode(event,ownerId){
 const limit=await limited('OWNER_REPORT_VERIFICATION_REQUEST',`${clientIp(event)}|${ownerId}`,3);
 if(!limit.allowed)return json(limit.unavailable?503:429,{message:limit.unavailable?'La verificación segura no está disponible temporalmente.':'Se alcanzó el límite de códigos. Espera antes de intentarlo nuevamente.'},{'Retry-After':String(limit.retryAfter||60)});
 const owner=await airtableGetRecord(TABLES.propietarios,ownerId).catch(()=>null),fields=owner?.fields||{},email=String(fields.Email||'').trim();
 if(!owner||!validEmail(email))return json(404,{message:'Esta casa no tiene un correo de verificación disponible. Contacta a administración.'});
 const issued=ownerSession.issueChallenge(ownerId);
 const sent=await sendMail({to:email,subject:`Código para Mis reportes · Casa ${Number(fields.Casa)||''}`,html:emailHtml({code:issued.code,casa:fields.Casa})});
 if(!sent?.sent)return json(503,{message:'No se pudo enviar el código de verificación. Intenta nuevamente más tarde.'});
 return json(200,{success:true,challenge:issued.challenge,expiresInSeconds:Math.ceil(ownerSession.CHALLENGE_TTL_MS/1000),message:'Enviamos un código de 6 dígitos al correo registrado de esta casa.'});
}
async function verifyCode(event,ownerId,body){
 const limit=await limited('OWNER_REPORT_VERIFICATION_VERIFY',`${clientIp(event)}|${ownerId}`,8);
 if(!limit.allowed)return json(limit.unavailable?503:429,{message:limit.unavailable?'La verificación segura no está disponible temporalmente.':'Demasiados intentos. Espera antes de volver a verificar.'},{'Retry-After':String(limit.retryAfter||60)});
 const challenge=String(body.challenge||''),code=String(body.code||'').trim();
 if(!ownerSession.verifyChallengeCode(ownerId,challenge,code))return json(401,{message:'El código es incorrecto o venció. Solicita uno nuevo.'});
 const token=ownerSession.issueOwnerSession(ownerId);
 return json(200,{success:true,message:'Dispositivo verificado. Tus reportes ya pueden sincronizarse aquí.'},{'Set-Cookie':ownerSession.sessionCookie(token)});
}
async function handler(event){
 if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return json(500,{message:'El seguimiento no está configurado.'});
 let body={};try{body=JSON.parse(event.body||'{}')}catch(_){return json(400,{message:'Solicitud inválida.'})}
 const ownerId=String(body.ownerId||'').trim(),action=String(body.action||'').trim().toLowerCase();
 if(!validOwnerId(ownerId))return json(400,{message:'Casa inválida para verificación.'});
 try{
  if(action==='request')return await requestCode(event,ownerId);
  if(action==='verify')return await verifyCode(event,ownerId,body);
  return json(400,{message:'Acción de verificación inválida.'});
 }catch(error){
  console.error('owner report session error:',error.code||error.message);
  return json(503,{message:'No se pudo completar la verificación segura. Intenta nuevamente.'});
 }
}

exports.handler=withAirtableUsage('public-owner-report-session',handler);
exports.requestCode=requestCode;
exports.verifyCode=verifyCode;
exports.emailHtml=emailHtml;
