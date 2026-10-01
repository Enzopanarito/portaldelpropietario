'use strict';

const {sign}=require('./_shared/_internal_job_auth');
const autopilot=require('./condo-autopilot-background');

const TARGET_DATE='2026-10-01';
const TARGET_MONTH='2026-09';
const CONFIRMATION='CLOSE-SEPTEMBER-2026-NOW';

function caracasDate(now=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'
  }).formatToParts(now).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

exports.handler=async function(event){
  if(String(event?.httpMethod||'').toUpperCase()!=='POST')return{statusCode:405,body:'Method Not Allowed'};
  if(caracasDate()!==TARGET_DATE)return{statusCode:410,body:'Recovery expired'};
  if(String(event?.headers?.['x-vla-recovery-confirm']||'')!==CONFIRMATION)return{statusCode:401,body:'Unauthorized'};

  const payload=JSON.stringify({
    requestedAt:new Date().toISOString(),
    source:'one-time-close-recovery',
    closingMonth:TARGET_MONTH
  });
  const authorization=sign(payload);
  const result=await autopilot.handler({
    __netlifyModernRuntime:event?.__netlifyModernRuntime===true,
    blobs:event?.blobs,
    httpMethod:'POST',
    headers:{
      'x-vla-job-timestamp':authorization.timestamp,
      'x-vla-job-signature':authorization.signature
    },
    body:payload,
    queryStringParameters:{},
    path:'/internal/monthly-close-recovery'
  });

  const status=Number(result?.statusCode||500);
  const body=String(result?.body||'');
  console.log(`VLA_ONE_TIME_CLOSE_RECOVERY status=${status} body=${body.slice(0,1200)}`);
  if(status!==200)throw new Error(`One-time close recovery failed with HTTP ${status}: ${body.slice(0,500)}`);
  return result;
};
