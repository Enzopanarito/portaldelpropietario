'use strict';

const crypto=require('crypto');
const{connectLambdaEvent}=require('./_blobs_compat');
const{createProofStore}=require('./_payment_proof_store');

function response(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}

exports.handler=async function(event){
 if(process.env.CONTEXT==='production')return response(404,{message:'Not Found'});
 if(event.httpMethod!=='GET')return response(405,{message:'Method Not Allowed'});
 try{
  connectLambdaEvent(event);
  const content=Buffer.from('VLA_PAYMENT_STORAGE_PROBE_V1','utf8'),attachmentSha=crypto.createHash('sha256').update(content).digest('hex');
  const proofStore=createProofStore({encryptionKey:Buffer.alloc(32,0x5a)}),env={...process.env,VLA_DATA_ENVIRONMENT:'staging'};
  const stored=await proofStore.put({reportId:'storage-probe-v1',content,contentType:'application/octet-stream',attachmentSha},env);
  const loaded=await proofStore.getByKey({key:stored.key,attachmentSha,contentType:'application/octet-stream'},env);
  if(!loaded||!loaded.content.equals(content))throw Object.assign(new Error('La lectura cifrada no coincidió con la escritura.'),{code:'STORAGE_PROBE_MISMATCH'});
  return response(200,{ok:true,encrypted:true,verified:true,created:stored.created});
 }catch(error){
  console.error(JSON.stringify({event:'VLA_PAYMENT_STORAGE_PROBE_FAILED',errorCode:String(error?.code||error?.name||'UNKNOWN').slice(0,120)}));
  return response(503,{ok:false,code:String(error?.code||error?.name||'STORAGE_PROBE_FAILED').slice(0,120)});
 }
};
