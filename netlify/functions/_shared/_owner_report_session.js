'use strict';

const crypto=require('crypto');

const DOMAIN='vla/owner-reports/session/v1';
const AUDIENCE='vla-owner-reports';
const COOKIE_NAME='vla_owner_reports';
const SESSION_TTL_MS=30*24*60*60*1000;
const CHALLENGE_TTL_MS=10*60*1000;
const CLOCK_SKEW_MS=60*1000;

function clean(value){return String(value||'').trim()}
function strong(value){return Buffer.byteLength(clean(value),'utf8')>=32}
function isProduction(env=process.env){
 const explicit=clean(env.VLA_DATA_ENVIRONMENT).toLowerCase(),context=clean(env.CONTEXT).toLowerCase();
 return explicit==='production'||context==='production';
}
function rootSecret(env=process.env){
 const admin=clean(env.ADMIN_TOKEN_SECRET);
 if(strong(admin))return admin;
 if(!isProduction(env)){
  const fallback=clean(env.PAYMENT_PROOF_ENCRYPTION_KEY);
  if(strong(fallback))return fallback;
 }
 throw Object.assign(new Error('No existe una clave fuerte para proteger el seguimiento del propietario.'),{code:'OWNER_REPORT_SESSION_SECRET_REQUIRED'});
}
function secret(env=process.env){
 return crypto.createHmac('sha256',Buffer.from(rootSecret(env),'utf8')).update(DOMAIN,'utf8').digest();
}
function base64url(input){
 return Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
function fromBase64url(input){
 const normalized=String(input||'').replace(/-/g,'+').replace(/_/g,'/');
 const pad=normalized.length%4?'='.repeat(4-(normalized.length%4)):'';
 return Buffer.from(normalized+pad,'base64').toString('utf8');
}
function sign(payload,env=process.env){
 return base64url(crypto.createHmac('sha256',secret(env)).update(String(payload),'utf8').digest());
}
function safeEqual(left,right){
 const a=Buffer.from(String(left||'')),b=Buffer.from(String(right||''));
 return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);
}
function encodeClaims(claims,env=process.env){
 const payload=base64url(JSON.stringify(claims));
 return `${payload}.${sign(payload,env)}`;
}
function decodeClaims(token,{type,now=Date.now(),env=process.env}={}){
 const parts=String(token||'').split('.');
 if(parts.length!==2)return null;
 const [payload,signature]=parts;
 let accepted=false;
 try{accepted=safeEqual(signature,sign(payload,env))}catch(_){return null}
 if(!accepted)return null;
 try{
  const claims=JSON.parse(fromBase64url(payload));
  if(!claims||claims.aud!==AUDIENCE||claims.typ!==type)return null;
  if(Number(claims.nbf||0)>now+CLOCK_SKEW_MS||Number(claims.exp||0)<=now-CLOCK_SKEW_MS)return null;
  if(!/^rec[A-Za-z0-9]{14}$/.test(String(claims.ownerId||'')))return null;
  return claims;
 }catch(_){return null}
}
function issueChallenge(ownerId,{now=Date.now(),env=process.env,nonce}={}){
 if(!/^rec[A-Za-z0-9]{14}$/.test(String(ownerId||'')))throw new Error('Propietario inválido.');
 const claims={aud:AUDIENCE,typ:'challenge',ownerId:String(ownerId),nonce:String(nonce||crypto.randomBytes(16).toString('hex')),iat:now,nbf:now-CLOCK_SKEW_MS,exp:now+CHALLENGE_TTL_MS};
 const challenge=encodeClaims(claims,env);
 const code=challengeCode(challenge,env);
 return{challenge,code,expiresAt:claims.exp};
}
function challengeCode(challenge,env=process.env){
 const digest=crypto.createHmac('sha256',secret(env)).update(`otp|${String(challenge||'')}`,'utf8').digest();
 return String(digest.readUInt32BE(0)%1000000).padStart(6,'0');
}
function verifyChallengeCode(ownerId,challenge,code,{now=Date.now(),env=process.env}={}){
 const claims=decodeClaims(challenge,{type:'challenge',now,env});
 if(!claims||claims.ownerId!==String(ownerId||'')||!/^\d{6}$/.test(String(code||'')))return false;
 let expected='';
 try{expected=challengeCode(challenge,env)}catch(_){return false}
 return safeEqual(expected,String(code));
}
function issueOwnerSession(ownerId,{now=Date.now(),env=process.env,jti}={}){
 if(!/^rec[A-Za-z0-9]{14}$/.test(String(ownerId||'')))throw new Error('Propietario inválido.');
 const claims={aud:AUDIENCE,typ:'session',ownerId:String(ownerId),jti:String(jti||crypto.randomBytes(16).toString('hex')),iat:now,nbf:now-CLOCK_SKEW_MS,exp:now+SESSION_TTL_MS};
 return encodeClaims(claims,env);
}
function verifyOwnerSession(token,ownerId,{now=Date.now(),env=process.env}={}){
 const claims=decodeClaims(token,{type:'session',now,env});
 if(!claims||claims.ownerId!==String(ownerId||'')||!/^[a-f0-9]{32}$/.test(String(claims.jti||'')))return null;
 return claims;
}
function cookieToken(event){
 const headers=event?.headers||{},raw=String(headers.cookie||headers.Cookie||'');
 for(const part of raw.split(';')){
  const index=part.indexOf('=');
  if(index<0)continue;
  const name=part.slice(0,index).trim();
  if(name!==COOKIE_NAME)continue;
  try{return decodeURIComponent(part.slice(index+1).trim())}catch(_){return part.slice(index+1).trim()}
 }
 return'';
}
function sessionFromEvent(event,ownerId,options={}){
 return verifyOwnerSession(cookieToken(event),ownerId,options);
}
function sessionCookie(token){
 const maxAge=Math.floor(SESSION_TTL_MS/1000);
 return`${COOKIE_NAME}=${encodeURIComponent(String(token||''))}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

module.exports={DOMAIN,AUDIENCE,COOKIE_NAME,SESSION_TTL_MS,CHALLENGE_TTL_MS,CLOCK_SKEW_MS,strong,isProduction,issueChallenge,challengeCode,verifyChallengeCode,issueOwnerSession,verifyOwnerSession,cookieToken,sessionFromEvent,sessionCookie};
