'use strict';

// Diagnóstico administrativo sin exponer la clave ni ejecutar una lectura costosa.
const {requireAdmin}=require('./_auth');
const {getActiveModelSelection}=require('./_payment_ai_model_discovery');

exports.handler=async function(event){
 const auth=requireAdmin(event);
 if(!auth.ok)return auth.response;
 if(event.httpMethod!=='GET')return{statusCode:405,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({message:'Method Not Allowed'})};
 const directConfigured=Boolean(String(process.env.GEMINI_API_KEY||'').trim());
 const proxyConfigured=Boolean(String(process.env.PAYMENT_PROOF_AI_PROXY_URL||'https://gemini-proxy-seinca.vercel.app/api/payment-proof').trim());
 const selection=directConfigured?await getActiveModelSelection({allowStale:true}).catch(()=>null):null;
 return{
  statusCode:200,
  headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},
  body:JSON.stringify({
   available:directConfigured||proxyConfigured,
   directConfigured,
   proxyConfigured,
   mode:directConfigured?'direct-with-proxy-fallback':'proxy-fallback',
   publicPrompting:false,
   dailySelection:selection?{
    primaryModel:selection.primaryModel,
    secondaryModel:selection.secondaryModel||'',
    benchmarkDate:selection.benchmarkDate||'',
    selectedAt:selection.selectedAt||null,
    validUntil:selection.validUntil||null,
    stale:Number(selection.validUntil||0)<=Date.now()
   }:null
  })
 };
};
