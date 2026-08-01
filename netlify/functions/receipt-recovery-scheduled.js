'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {sign}=require('./_internal_job_auth');

const TABLE_RECEIPTS='Recibos de Pago';
const RECOVERABLE_STATES=['Error PDF','Error correo','Pendiente','Proveedor no configurado','Remitente inválido'];

function airtableUrl(){
 const formula=`OR(${RECOVERABLE_STATES.map(value=>`{Estado Email}='${value}'`).join(',')})`;
 const params=new URLSearchParams({filterByFormula:formula,maxRecords:'5',pageSize:'5'});
 params.append('fields[]','Nro Recibo');
 params.append('fields[]','Estado Email');
 return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_RECEIPTS)}?${params.toString()}`;
}

async function listCandidates(){
 if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)throw new Error('Airtable no está configurado.');
 const response=await fetch(airtableUrl(),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error?.message||data.message||'No se pudieron consultar los recibos pendientes.');
 return data.records||[];
}

async function queue(receiptId){
 const site=String(process.env.URL||'').replace(/\/$/,'');
 if(!site)throw new Error('Falta URL del sitio.');
 const payload=JSON.stringify({receiptId}),authorization=sign(payload);
 const response=await fetch(`${site}/api/vla/receipt-recovery`,{
  method:'POST',
  headers:{
   'Content-Type':'application/json',
   'x-vla-job-timestamp':authorization.timestamp,
   'x-vla-job-signature':authorization.signature
  },
  body:payload
 });
 return{receiptId,queued:response.ok,status:response.status};
}

const handler=async function(){
 try{
  const candidates=await listCandidates(),results=[];
  for(const receipt of candidates){
   results.push(await queue(receipt.id).catch(error=>({receiptId:receipt.id,queued:false,error:String(error.message||error).slice(0,200)})));
  }
  return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,candidates:candidates.length,queued:results.filter(result=>result.queued).length,results})};
 }catch(error){
  return{statusCode:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:false,message:'No se pudo iniciar la recuperación de recibos.',detail:String(error.message||error).slice(0,300)})};
 }
};

exports.handler=withAirtableUsage('receipt-recovery-scheduled',handler);
exports.listCandidates=listCandidates;
exports.queue=queue;
