'use strict';

const previous=require('./public-data-v2');
const { requireAdmin }=require('./_auth');
const { assertSafeAirtableContext,isolationResponse }=require('./_environment_guard');
const { readSnapshot,writeSnapshot }=require('./_public_snapshot_store');

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','Pragma':'no-cache'};
function response(statusCode,body,extra={}){return{statusCode,headers:{...HEADERS,...extra},body:JSON.stringify(body)};}
function wantsRefresh(event){return event&&event.queryStringParameters&&event.queryStringParameters.force==='1';}

async function buildFromSource(event){
  assertSafeAirtableContext({write:false,allowUnclassified:true});
  const rebuilt=await previous.handler({...event,queryStringParameters:{...(event.queryStringParameters||{}),force:'1'}});
  if(rebuilt.statusCode!==200)return rebuilt;
  const payload=JSON.parse(rebuilt.body||'{}');
  const stored=await writeSnapshot(payload,{source:'airtable-v5',generatedAt:payload.generatedAt||new Date().toISOString()});
  return response(200,stored.payload,{'X-Public-Snapshot':'REBUILT','X-Airtable-Calls':rebuilt.headers&&rebuilt.headers['X-Airtable-Calls']||'0'});
}

const handler=async function(event){
  try{
    const refresh=wantsRefresh(event);
    if(refresh){
      const auth=requireAdmin(event);
      if(!auth.ok)return response(403,{message:'La reconstrucción manual de la fotografía pública requiere sesión administrativa.'},{'X-Public-Snapshot':'REFRESH-DENIED'});
      return await buildFromSource(event);
    }

    const snapshot=await readSnapshot();
    if(snapshot)return response(200,snapshot.payload,{'X-Public-Snapshot':'HIT','X-Airtable-Calls':'0','ETag':snapshot.etag||''});
    return await buildFromSource(event);
  }catch(error){
    if(error&&String(error.code||'').startsWith('AIRTABLE_'))return isolationResponse(error);
    try{
      const stale=await readSnapshot();
      if(stale)return response(200,{...stale.payload,stale:true,warnings:[...(stale.payload.warnings||[]),{table:'snapshot',detail:'No se pudo reconstruir; se conserva la última fotografía válida.'}]},{'X-Public-Snapshot':'STALE','X-Airtable-Calls':'0'});
    }catch(_){ }
    return response(503,{message:'No existe una fotografía pública válida y no fue posible reconstruirla.',detail:String(error&&error.message||'').slice(0,500)},{'X-Public-Snapshot':'ERROR'});
  }
};

exports.handler=handler;
exports.buildFromSource=buildFromSource;
