'use strict';

const crypto=require('crypto');
const MAX_CLOCK_SKEW_MS=5*60*1000;

function clean(value){return String(value??'').trim()}
function secret(env=process.env){return clean(env.AUTOMATION_JOB_SECRET||env.ADMIN_TOKEN_SECRET||env.ADMIN_PASSWORD)}
function sign(body,{timestamp=Date.now(),env=process.env}={}){
 const key=secret(env);if(!key)throw new Error('Falta AUTOMATION_JOB_SECRET o un secreto administrativo.');
 const text=typeof body==='string'?body:JSON.stringify(body||{});
 const stamp=String(timestamp),signature=crypto.createHmac('sha256',key).update(`${stamp}.${text}`).digest('hex');
 return{timestamp:stamp,signature};
}
function safeEqual(left,right){const a=Buffer.from(clean(left)),b=Buffer.from(clean(right));return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b)}
function verify(body,headers={},env=process.env,{now=Date.now()}={}){
 const stamp=clean(headers['x-vla-job-timestamp']||headers['X-Vla-Job-Timestamp']),provided=clean(headers['x-vla-job-signature']||headers['X-Vla-Job-Signature']),timestamp=Number(stamp);
 if(!Number.isFinite(timestamp)||Math.abs(now-timestamp)>MAX_CLOCK_SKEW_MS)return false;
 try{return safeEqual(provided,sign(typeof body==='string'?body:JSON.stringify(body||{}),{timestamp:stamp,env}).signature)}catch(_){return false}
}

module.exports={MAX_CLOCK_SKEW_MS,clean,secret,sign,safeEqual,verify};
