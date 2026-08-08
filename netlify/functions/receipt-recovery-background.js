'use strict';

const {withAirtableUsage}=require('./_airtable_meter');
const {verify}=require('./_internal_job_auth');
const {hashPayload,connectForEvent,claim,complete,failSafe}=require('./_idempotency_blobs');
const {retryExistingReceipt,finalizeExistingReceiptDelivery}=require('./_receipt_service');
const {safeDisplayText}=require('./_security_utils');

function response(statusCode,body){
 return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)};
}

const handler=async function(event){
 const rawBody=event.body||'';
 if(event.httpMethod!=='POST')return response(405,{message:'Method Not Allowed'});
 if(!verify(rawBody,event.headers||{}))return response(401,{message:'No autorizado.'});
 let body={};
 try{body=JSON.parse(rawBody||'{}')}catch(_){return response(400,{message:'Solicitud inválida.'})}
 const receiptId=String(body.receiptId||'').trim();
 if(!/^rec[A-Za-z0-9]{10,}$/.test(receiptId))return response(400,{message:'Recibo inválido.'});

 connectForEvent(event);
 const marker=await claim({
  scope:'receipt-delivery-recovery',
  businessKey:receiptId,
  payloadHash:hashPayload({receiptId}),
  ttlMs:20*60*1000
 });
 if(!marker.ok){
  if(marker.reason==='done'&&marker.result?.auditPatchPending===true){
   try{
    await finalizeExistingReceiptDelivery(receiptId,marker.result.audit||{});
    return response(200,{success:true,receiptId,idempotent:true,sent:true,auditRepaired:true,message:'La auditoría del recibo enviado fue reparada sin reenviar el correo.'});
   }catch(error){
    return response(200,{success:false,receiptId,idempotent:true,sent:true,auditPending:true,message:'El correo ya fue enviado; la auditoría seguirá reintentándose sin duplicarlo.'});
   }
  }
  return response(200,{success:true,receiptId,idempotent:true,state:marker.reason,message:'La recuperación ya fue procesada o está en curso.'});
 }

 try{
  const result=await retryExistingReceipt(receiptId);
  if(result.email?.sent===true||result.idempotent===true){
   await complete(marker,{receiptId,status:result.email?.status||'Enviado'});
   return response(200,{success:true,receiptId,idempotent:result.idempotent===true,sent:true,status:result.email?.status||'Enviado'});
  }
  await failSafe(marker,{receiptId,status:result.email?.status||'Pendiente'},'RECEIPT_DELIVERY_PENDING');
  return response(200,{success:false,receiptId,sent:false,status:result.email?.status||'Pendiente',message:'El recibo permanece protegido para el próximo reintento.'});
 }catch(error){
  if(error.deliverySent===true){
   await complete(marker,{receiptId,deliverySent:true,auditPatchPending:true,audit:error.deliveryAudit||{}});
   return response(200,{success:true,receiptId,sent:true,auditPending:true,message:'El recibo fue enviado; la auditoría se completará sin volver a enviar el correo.'});
  }
  await failSafe(marker,{receiptId,error:safeDisplayText(error.message,300)},'RECEIPT_RECOVERY_FAILED').catch(()=>{});
  console.error('RECEIPT_RECOVERY_FAILED',safeDisplayText(error.message,300));
  return response(500,{success:false,receiptId,message:'El recibo quedó protegido para reintento.',code:'RECEIPT_RECOVERY_FAILED'});
 }
};

exports.handler=withAirtableUsage('receipt-recovery-background',handler);
