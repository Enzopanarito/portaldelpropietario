'use strict';

const previous=require('./public-data-v2');
const snapshotStore=require('./_public_snapshot_store');

function response(statusCode,payload,headers={}){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(payload)};
}
function parseBody(result){try{return JSON.parse(result&&result.body||'{}')}catch(_){return{}}}
function cachedResponse(snapshot,state,extra={}){
 return response(200,snapshot.payload,{'X-Public-Snapshot':state,'X-Airtable-Calls':'0','X-Balance-Engine':'5',...extra});
}
function forceEvent(event){return{...event,queryStringParameters:{...(event.queryStringParameters||{}),force:'1'}}}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function waitForSnapshot(readSnapshot=snapshotStore.readPublicSnapshot,sleepFn=sleep){
 for(let attempt=0;attempt<12;attempt+=1){await sleepFn(250);const current=await readSnapshot().catch(()=>null);if(current&&current.ok&&current.fresh)return current}
 return null;
}

function createHandler(deps={}){
 const previousHandler=deps.previousHandler||previous.handler;
 const isEnabled=deps.enabled||snapshotStore.enabled;
 const readSnapshot=deps.readPublicSnapshot||snapshotStore.readPublicSnapshot;
 const writeSnapshot=deps.writePublicSnapshot||snapshotStore.writePublicSnapshot;
 const claimRefresh=deps.claimPublicRefresh||snapshotStore.claimPublicRefresh;
 const releaseRefresh=deps.releasePublicRefresh||snapshotStore.releasePublicRefresh;
 const waitSnapshot=deps.waitForSnapshot||(()=>waitForSnapshot(readSnapshot,deps.sleep||sleep));

 return async function handler(event){
  if(!isEnabled())return previousHandler(event);
  let cached=null;
  let blobReadError=null;
  try{cached=await readSnapshot()}catch(error){blobReadError=error}
  if(cached&&cached.ok&&cached.fresh)return cachedResponse(cached.snapshot,'HIT');

  let lease=null;
  if(!blobReadError){
   try{lease=await claimRefresh()}catch(error){blobReadError=error}
  }
  if(lease&&!lease.ok){
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE',{'Warning':'110 - "Respuesta pública temporalmente antigua durante revalidación"'});
   const refreshed=await waitSnapshot().catch(()=>null);
   if(refreshed)return cachedResponse(refreshed.snapshot,'WAIT_HIT');
   return response(503,{message:'La fotografía pública se está reconstruyendo. Intente nuevamente en unos segundos.'},{'Retry-After':'3','X-Public-Snapshot':'REFRESH_BUSY'});
  }

  try{
   const fresh=await previousHandler(forceEvent(event));
   const payload=parseBody(fresh);
   if(fresh.statusCode===200){
    let writeWarning=null;
    if(!blobReadError){
     try{await writeSnapshot(payload)}catch(error){writeWarning=String(error.message||'').slice(0,300)}
    }
    return response(200,payload,{
     ...(fresh.headers||{}),
     'Cache-Control':'no-store',
     'X-Public-Snapshot':blobReadError?'BLOB_UNAVAILABLE':writeWarning?'WRITE_WARNING':'REFRESH',
     ...(writeWarning?{'X-Public-Snapshot-Warning':writeWarning}:{})
    });
   }
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE_FALLBACK',{'Warning':'111 - "Airtable no disponible; se sirvió la última fotografía validada"'});
   return fresh;
  }catch(error){
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE_EXCEPTION',{'Warning':'111 - "Error de revalidación; se sirvió la última fotografía validada"'});
   return response(503,{message:'No existe una fotografía pública validada y no fue posible reconstruirla.',detail:String(error.message||'').slice(0,300)},{'X-Public-Snapshot':'ERROR'});
  }finally{
   if(lease&&lease.ok)await releaseRefresh(lease).catch(()=>null);
  }
 };
}

const handler=createHandler();
exports.handler=handler;
module.exports={handler,createHandler,response,parseBody,forceEvent,cachedResponse,waitForSnapshot};
