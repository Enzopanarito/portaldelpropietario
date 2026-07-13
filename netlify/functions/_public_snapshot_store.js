'use strict';

const STORE_NAME='vla-public-balance-snapshot-v1';
const SNAPSHOT_KEY='current/public-data.json';
let storeFactoryOverride=null;

function setStoreFactoryForTests(factory){storeFactoryOverride=factory||null;}
function contextKind(){return process.env.CONTEXT==='production'?'production':'deploy';}
async function runtimeStore(){
  if(storeFactoryOverride)return storeFactoryOverride();
  const sdk=await import('@netlify/blobs');
  if(contextKind()==='production')return sdk.getStore({name:STORE_NAME,consistency:'strong'});
  return sdk.getDeployStore(STORE_NAME);
}
function validatePayload(payload){
  if(!payload||typeof payload!=='object')throw new Error('Fotografía pública inválida.');
  if(Number(payload.balanceEngineVersion)!==5)throw new Error('La fotografía pública no usa el motor financiero v5.');
  if(!Array.isArray(payload.propietarios)||payload.propietarios.length!==15)throw new Error('La fotografía pública debe contener exactamente 15 propietarios.');
  const houses=payload.propietarios.map(item=>Number(item&&item.Casa)).sort((a,b)=>a-b);
  if(houses.some((house,index)=>house!==index+1))throw new Error('La fotografía pública no contiene las casas 1 a 15 una sola vez.');
  return payload;
}
async function readSnapshot(){
  const store=await runtimeStore();
  const entry=await store.getWithMetadata(SNAPSHOT_KEY,{type:'json',consistency:'strong'});
  if(!entry||!entry.data)return null;
  return {payload:validatePayload(entry.data),etag:entry.etag,metadata:entry.metadata||{}};
}
async function writeSnapshot(payload,{source='airtable',generatedAt=new Date().toISOString()}={}){
  validatePayload(payload);
  const store=await runtimeStore();
  const value={...payload,snapshotSource:source,snapshotGeneratedAt:generatedAt};
  const result=await store.setJSON(SNAPSHOT_KEY,value,{metadata:{generatedAt,source,balanceEngineVersion:5,ownerCount:15}});
  if(!result||result.modified!==true)throw new Error('No se pudo publicar la fotografía pública.');
  return {payload:value,etag:result.etag,metadata:{generatedAt,source,balanceEngineVersion:5,ownerCount:15}};
}
async function invalidateSnapshot(){const store=await runtimeStore();await store.delete(SNAPSHOT_KEY);}

module.exports={STORE_NAME,SNAPSHOT_KEY,setStoreFactoryForTests,contextKind,runtimeStore,validatePayload,readSnapshot,writeSnapshot,invalidateSnapshot};
