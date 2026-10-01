import auth from './_shared/_internal_job_auth.js';
import watchdog from './_shared/_monthly_close_watchdog.js';

function env(name){
  return String(Netlify.env.get(name)||'').trim();
}

async function closeMarkers(month){
  const token=env('AIRTABLE_API_TOKEN');
  const baseId=env('AIRTABLE_BASE_ID');
  if(!token||!baseId)throw new Error('Airtable no está configurado para el watchdog.');
  const prefix=`MONTHLY_CLOSE|${month}|`;
  const formula=`LEFT({Key}, ${prefix.length})='${prefix}'`;
  const url=new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('ControlVersiones')}`);
  url.searchParams.set('filterByFormula',formula);
  url.searchParams.append('fields[]','Key');
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.error?.message||'No se pudo leer el estado del cierre.');
  return data.records||[];
}

function signingEnv(){
  return{
    AUTOMATION_JOB_SECRET:env('AUTOMATION_JOB_SECRET'),
    ADMIN_TOKEN_SECRET:env('ADMIN_TOKEN_SECRET'),
    ADMIN_PASSWORD:env('ADMIN_PASSWORD')
  };
}

export default async (_request,context)=>{
  const calendarMonth=watchdog.caracasMonth();
  const closingMonth=watchdog.previousMonth(calendarMonth);
  const markers=await closeMarkers(closingMonth);
  const decision=watchdog.shouldQueue(markers,closingMonth);
  if(!decision.queue){
    console.log(`VLA_CLOSE_WATCHDOG_SKIP month=${closingMonth} state=${decision.state}`);
    return;
  }
  const payload=JSON.stringify({
    requestedAt:new Date().toISOString(),
    source:'monthly-close-watchdog',
    closingMonth
  });
  const authorization=auth.sign(payload,{env:signingEnv()});
  const target=new URL('/api/vla/condo-autopilot',context.site.url);
  const queued=await fetch(target,{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'x-vla-job-timestamp':authorization.timestamp,
      'x-vla-job-signature':authorization.signature
    },
    body:payload
  });
  if(!queued.ok)throw new Error(`El watchdog no pudo encolar el cierre: HTTP ${queued.status}`);
  console.log(`VLA_CLOSE_WATCHDOG_QUEUED month=${closingMonth} priorState=${decision.state}`);
};

export const config={schedule:'* 4 1 * *'};
