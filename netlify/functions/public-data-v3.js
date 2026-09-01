'use strict';

const previous=require('./public-data-v2');
const snapshotStore=require('./_shared/_public_snapshot_store');
const previewFixture=require('./_shared/_public_preview_fixture');

function response(statusCode,payload,headers={}){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers},body:JSON.stringify(payload)}}
function parseBody(result){try{return JSON.parse(result&&result.body||'{}')}catch(_){return{}}}
function cachedResponse(snapshot,state,extra={}){return response(200,snapshot.payload,{'X-Public-Snapshot':state,'X-Airtable-Calls':'0','X-Balance-Engine':'5',...extra})}
function forceEvent(event){return{...event,queryStringParameters:{...(event.queryStringParameters||{}),force:'1'}}}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function blobErrorCode(error){const code=String(error?.code||'');if(/^BLOBS_[A-Z0-9_]+$/.test(code))return code;if(error?.name==='MissingBlobsEnvironmentError')return'BLOBS_CONTEXT_MISSING';return'BLOBS_UNAVAILABLE'}
function requestHeader(event,name){const headers=event?.headers||{},wanted=String(name||'').toLowerCase();for(const[key,value]of Object.entries(headers)){if(String(key).toLowerCase()===wanted)return String(value||'')}return''}
function whatsappFinancialPaused(event,env=process.env){return String(env?.VLA_WHATSAPP_FINANCIAL_PAUSE||'').trim().toLowerCase()==='true'&&/VLA-WhatsApp-Agent\//i.test(requestHeader(event,'user-agent'))}
async function waitForSnapshot(readSnapshot=snapshotStore.readPublicSnapshot,sleepFn=sleep,env=process.env){for(let attempt=0;attempt<12;attempt+=1){await sleepFn(250);const current=await readSnapshot(env).catch(()=>null);if(current&&current.ok&&current.fresh)return current}return null}

function createHandler(deps={}){
 const previousHandler=deps.previousHandler||previous.handler;
 const isEnabled=deps.enabled||snapshotStore.enabled;
 const eventEnvironment=deps.environmentForEvent||snapshotStore.environmentForEvent;
 const eventHost=deps.requestHost||snapshotStore.requestHost;
 const connectSnapshot=deps.connectPublicSnapshot||snapshotStore.connectPublicSnapshot;
 const readSnapshot=deps.readPublicSnapshot||snapshotStore.readPublicSnapshot;
 const writeSnapshot=deps.writePublicSnapshot||snapshotStore.writePublicSnapshot;
 const claimRefresh=deps.claimPublicRefresh||snapshotStore.claimPublicRefresh;
 const releaseRefresh=deps.releasePublicRefresh||snapshotStore.releasePublicRefresh;
 const expectedEtag=deps.snapshotExpectedEtag||snapshotStore.snapshotExpectedEtag;
 const previewEnabled=deps.previewEnabled||previewFixture.enabled;
 const createPreviewPayload=deps.createPreviewPayload||previewFixture.createPayload;
 const previewHeaders=deps.previewHeaders||previewFixture.headers;
 const now=deps.now||(()=>new Date());
 const financialPause=deps.whatsappFinancialPaused||whatsappFinancialPaused;

 return async function handler(event){
  const host=eventHost(event);
  const snapshotEnv=eventEnvironment(event);

  // Los Deploy Previews, branch deploys y el entorno local nunca consultan la
  // base de producción. Reciben una fotografía ficticia y determinista que
  // permite probar las 15 casas, el desglose y el diseño sin escrituras ni
  // dependencia de credenciales o del esquema incompleto de staging.
  if(previewEnabled(snapshotEnv)){
   return response(200,createPreviewPayload(now()),{
    ...previewHeaders(),
    'X-Public-Snapshot':'PREVIEW_FIXTURE'
   });
  }

  // Cortacircuito financiero: el portal sigue disponible para propietarios,
  // pero el agente de WhatsApp no puede consumir saldos mientras exista una
  // incidencia contable activa. El agente aborta el ciclo ante cualquier HTTP
  // distinto de 2xx, evitando enviar datos no certificados.
  if(financialPause(event,process.env)){
   return response(503,{message:'Envíos financieros de WhatsApp pausados hasta certificar el cierre contable.'},{'Retry-After':'300','X-VLA-WhatsApp-Financial-Pause':'1'});
  }

  if(!isEnabled(snapshotEnv,snapshotStore.runtimeConfig,host))return previousHandler(event);
  const waitSnapshot=deps.waitForSnapshot||(()=>waitForSnapshot(readSnapshot,deps.sleep||sleep,snapshotEnv));
  let cached=null,blobReadError=null;
  try{await connectSnapshot(event);cached=await readSnapshot(snapshotEnv)}catch(error){blobReadError=error}
  if(cached&&cached.ok&&cached.fresh)return cachedResponse(cached.snapshot,'HIT');
  const versionRead=blobReadError?undefined:expectedEtag(cached);

  let lease=null;
  if(!blobReadError){try{lease=await claimRefresh(snapshotEnv)}catch(error){blobReadError=error}}
  if(lease&&!lease.ok){
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE',{'Warning':'110 - "Respuesta pública temporalmente antigua durante revalidación"'});
   const refreshed=await waitSnapshot().catch(()=>null);
   if(refreshed)return cachedResponse(refreshed.snapshot,'WAIT_HIT');
   return response(503,{message:'La fotografía pública se está reconstruyendo. Intente nuevamente en unos segundos.'},{'Retry-After':'3','X-Public-Snapshot':'REFRESH_BUSY'});
  }

  try{
   const fresh=await previousHandler(forceEvent(event)),payload=parseBody(fresh);
   if(fresh.statusCode===200){
    let writeWarning=null;
    if(!blobReadError){try{await writeSnapshot(payload,snapshotEnv,versionRead)}catch(error){writeWarning=`${error.code||'PUBLIC_SNAPSHOT_WRITE'}: ${String(error.message||'').slice(0,240)}`}}
    return response(200,payload,{...(fresh.headers||{}),'Cache-Control':'no-store','X-Public-Snapshot':blobReadError?'BLOB_UNAVAILABLE':writeWarning?'WRITE_WARNING':'REFRESH',...(blobReadError?{'X-Public-Snapshot-Error':blobErrorCode(blobReadError)}:{}),...(writeWarning?{'X-Public-Snapshot-Warning':writeWarning}:{})});
   }
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE_FALLBACK',{'Warning':'111 - "Airtable no disponible; se sirvió la última fotografía validada"'});
   return fresh;
  }catch(error){
   if(cached&&cached.ok)return cachedResponse(cached.snapshot,'STALE_EXCEPTION',{'Warning':'111 - "Error de revalidación; se sirvió la última fotografía validada"'});
   return response(503,{message:'No existe una fotografía pública validada y no fue posible reconstruirla.',detail:String(error.message||'').slice(0,300)},{'X-Public-Snapshot':'ERROR'});
  }finally{if(lease&&lease.ok)await releaseRefresh(lease,snapshotEnv).catch(()=>null)}
 };
}

const handler=createHandler();
exports.handler=handler;
module.exports={handler,createHandler,response,parseBody,forceEvent,cachedResponse,waitForSnapshot,blobErrorCode,requestHeader,whatsappFinancialPaused};
