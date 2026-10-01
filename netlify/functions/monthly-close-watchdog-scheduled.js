'use strict';

const {sign}=require('./_shared/_internal_job_auth');
const watchdog=require('./_shared/_monthly_close_watchdog');
const {resolveInternalSiteUrl}=require('./_shared/_internal_site_url');
const autopilot=require('./condo-autopilot-background');

function response(statusCode,body){
  return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

async function closeMarkers(month){
  const token=String(process.env.AIRTABLE_API_TOKEN||'').trim();
  const baseId=String(process.env.AIRTABLE_BASE_ID||'').trim();
  if(!token||!baseId)throw new Error('Airtable no está configurado para el watchdog.');
  const prefix=`MONTHLY_CLOSE|${month}|`;
  const formula=`LEFT({Key}, ${prefix.length})='${prefix}'`;
  const url=new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('ControlVersiones')}`);
  url.searchParams.set('filterByFormula',formula);
  url.searchParams.append('fields[]','Key');
  const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data?.error?.message||'No se pudo leer el estado del cierre.');
  return data.records||[];
}

const handler=async function(event){
  try{
    const calendarMonth=watchdog.caracasMonth();
    const closingMonth=watchdog.previousMonth(calendarMonth);
    const markers=await closeMarkers(closingMonth);
    const decision=watchdog.shouldQueue(markers,closingMonth);

    if(!decision.queue){
      return response(200,{success:true,queued:false,month:closingMonth,state:decision.state});
    }

    const payload=JSON.stringify({
      requestedAt:new Date().toISOString(),
      source:'monthly-close-watchdog',
      closingMonth
    });
    const authorization=sign(payload);

    if(event?.__netlifyModernRuntime===true){
      const result=await autopilot.handler({
        __netlifyModernRuntime:true,
        httpMethod:'POST',
        headers:{
          'content-type':'application/json',
          'x-vla-job-timestamp':authorization.timestamp,
          'x-vla-job-signature':authorization.signature
        },
        body:payload,
        queryStringParameters:{},
        path:'/internal/monthly-close-watchdog'
      });
      let body={};
      try{body=JSON.parse(result?.body||'{}')}catch(_){}
      if(Number(result?.statusCode||500)!==200||body?.success!==true){
        throw new Error(`El autopiloto directo respondió HTTP ${Number(result?.statusCode||500)}: ${String(body?.detail||body?.message||'sin detalle').slice(0,180)}`);
      }
      return response(200,{success:true,queued:false,executed:true,month:closingMonth,priorState:decision.state,autopilot:body});
    }

    const site=resolveInternalSiteUrl(process.env);
    const queued=await fetch(`${site}/api/vla/condo-autopilot`,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-vla-job-timestamp':authorization.timestamp,
        'x-vla-job-signature':authorization.signature
      },
      body:payload
    });
    if(!queued.ok)throw new Error(`El watchdog no pudo encolar el cierre: HTTP ${queued.status}`);

    return response(202,{success:true,queued:true,month:closingMonth,priorState:decision.state});
  }catch(error){
    return response(500,{success:false,message:'No se pudo recuperar el cierre mensual.',detail:String(error.message||error).slice(0,300)});
  }
};

exports.handler=handler;
