'use strict';

const {sign}=require('./_shared/_internal_job_auth');

function response(statusCode,body){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

const handler=async function(){
 try{
  const site=String(process.env.URL||'').replace(/\/$/,'');
  if(!site)throw new Error('Falta URL del sitio.');
  const payload=JSON.stringify({requestedAt:new Date().toISOString(),source:'access-reconciliation-schedule'});
  const authorization=sign(payload);
  const queued=await fetch(`${site}/api/vla/access-reconciliation`,{
   method:'POST',
   headers:{
    'Content-Type':'application/json',
    'x-vla-job-timestamp':authorization.timestamp,
    'x-vla-job-signature':authorization.signature
   },
   body:payload
  });
  if(!queued.ok)throw new Error(`La cola respondió ${queued.status}.`);
  return response(202,{success:true,queued:true,message:'Reconciliación periódica del portón enviada.'});
 }catch(error){
  return response(500,{success:false,message:'No se pudo iniciar la reconciliación del portón.',detail:String(error.message||error).slice(0,300)});
 }
};

exports.handler=handler;
