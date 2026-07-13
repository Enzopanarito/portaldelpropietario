'use strict';

const crypto=require('crypto');
const ISSUER='villa-los-apamates';
const AUDIENCE='vla-whatsapp-dispatch';
const DEFAULT_TTL_MS=60*60*1000;
const CLOCK_SKEW_MS=60*1000;

function base64url(value){return Buffer.from(value).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}
function decodeBase64url(value){const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/');const pad=normalized.length%4?'='.repeat(4-normalized.length%4):'';return Buffer.from(normalized+pad,'base64').toString('utf8')}
function secret(){const raw=process.env.MESSAGING_DISPATCH_SECRET||process.env.ADMIN_TOKEN_SECRET||process.env.ADMIN_PASSWORD||'';if(!raw)throw new Error('No existe secreto para autorizar el conector.');return crypto.createHmac('sha256',raw).update('VLA_WHATSAPP_DISPATCH_V1').digest()}
function sign(payload){return base64url(crypto.createHmac('sha256',secret()).update(payload).digest())}
function safeEqual(left,right){const a=Buffer.from(String(left||'')),b=Buffer.from(String(right||''));return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b)}
function issueDispatchToken({jobId,mode,revision,ttlMs=DEFAULT_TTL_MS,now=Date.now()}={}){
  if(!/^WA-[A-Z0-9-]{10,80}$/.test(String(jobId||'')))throw new Error('Job ID inválido para despacho.');
  const issued=Number(now);const claims={iss:ISSUER,aud:AUDIENCE,scope:'execute-job',jobId:String(jobId),mode:String(mode||''),revision:Number(revision||0),jti:crypto.randomBytes(16).toString('hex'),iat:issued,nbf:issued-CLOCK_SKEW_MS,exp:issued+Math.max(5*60*1000,Math.min(2*60*60*1000,Number(ttlMs||0)))};
  const payload=base64url(JSON.stringify(claims));return`${payload}.${sign(payload)}`;
}
function verifyDispatchToken(token,{jobId='',now=Date.now()}={}){
  const parts=String(token||'').split('.');if(parts.length!==2)return null;const[payload,signature]=parts;if(!safeEqual(signature,sign(payload)))return null;
  try{const claims=JSON.parse(decodeBase64url(payload));const time=Number(now);if(claims.iss!==ISSUER||claims.aud!==AUDIENCE||claims.scope!=='execute-job')return null;if(Number(claims.nbf||0)>time+CLOCK_SKEW_MS||Number(claims.exp||0)<=time)return null;if(!/^[a-f0-9]{32}$/.test(String(claims.jti||'')))return null;if(jobId&&claims.jobId!==jobId)return null;return claims}catch{return null}
}
function tokenFromEvent(event){const headers=event&&event.headers||{};const authorization=headers.authorization||headers.Authorization||'';return String(authorization).toLowerCase().startsWith('bearer ')?String(authorization).slice(7).trim():headers['x-vla-dispatch-token']||headers['X-VLA-Dispatch-Token']||''}
function requireDispatch(event,options={}){const claims=verifyDispatchToken(tokenFromEvent(event),options);if(claims)return{ok:true,claims};return{ok:false,response:{statusCode:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store','WWW-Authenticate':'Bearer realm="vla-whatsapp-dispatch"'},body:JSON.stringify({message:'Despacho no autorizado o vencido.'})}}}

module.exports={ISSUER,AUDIENCE,DEFAULT_TTL_MS,CLOCK_SKEW_MS,base64url,decodeBase64url,issueDispatchToken,verifyDispatchToken,tokenFromEvent,requireDispatch};
