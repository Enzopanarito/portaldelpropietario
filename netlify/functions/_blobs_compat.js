'use strict';

// La referencia estática permite que el empaquetador de Netlify habilite el
// contexto Blobs en funciones que usan el formato Lambda compatible.
let netlifyBlobs=null;
function sdk(){if(!netlifyBlobs)netlifyBlobs=require('@netlify/blobs');return netlifyBlobs}

function codedError(code,message){const error=new Error(message);error.code=code;return error}
function connectLambdaEvent(event,env=process.env){
 if(env.NETLIFY_BLOBS_CONTEXT)return{connected:true,source:'environment'};
 if(!event?.blobs)throw codedError('BLOBS_EVENT_CONTEXT_MISSING','Netlify no entregó el contexto Blobs para esta función Lambda.');
 sdk().connectLambda(event);
 return{connected:true,source:'event'};
}
function validateConditions(options){
 if(options.onlyIfMatch&&options.onlyIfNew)throw codedError('BLOBS_CONDITION_CONFLICT','onlyIfMatch y onlyIfNew son mutuamente excluyentes.');
 if(options.onlyIfMatch&&typeof options.onlyIfMatch!=='string')throw codedError('BLOBS_ETAG_INVALID','onlyIfMatch requiere un ETag.');
}
async function atomicSetJSON(store,key,data,options={}){
 validateConditions(options);
 if(!store?.client?.makeRequest||!store?.name)throw codedError('BLOBS_ATOMIC_ADAPTER_UNAVAILABLE','La versión fijada de Blobs no expuso el transporte requerido.');
 const headers={'content-type':'application/json'};
 if(options.onlyIfMatch)headers['if-match']=options.onlyIfMatch;
 else if(options.onlyIfNew)headers['if-none-match']='*';
 const result=await store.client.makeRequest({body:JSON.stringify(data),headers,key,metadata:options.metadata,method:'put',storeName:store.name});
 const etag=String(result?.headers?.get?.('etag')||'');
 if(result?.status===412&&(options.onlyIfMatch||options.onlyIfNew))return{modified:false,etag};
 if(result?.status!==200)throw codedError('BLOBS_WRITE_FAILED',`Netlify Blobs rechazó la escritura con estado ${Number(result?.status||0)}.`);
 return{modified:true,etag};
}
function wrapStore(store){
 return{
  getWithMetadata:(key,options)=>store.getWithMetadata(key,options),
  setJSON:(key,data,options)=>atomicSetJSON(store,key,data,options)
 };
}
function getAtomicStore(name,options={}){return wrapStore(sdk().getStore({name,...options}))}

module.exports={connectLambdaEvent,validateConditions,atomicSetJSON,wrapStore,getAtomicStore};
