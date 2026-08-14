'use strict';

const {requireAdmin}=require('./_shared/_auth');
const {airtableGetRecord,TABLES}=require('./_shared/_access_control');
const {createProofStore}=require('./_shared/_payment_proof_store');
const {connectLambdaEvent}=require('./_shared/_blobs_compat');

function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}}
function validRecordId(value){return /^rec[A-Za-z0-9]{14}$/.test(String(value||'').trim())}
function safeFilename(value,contentType){const extension=contentType==='application/pdf'?'.pdf':contentType==='image/png'?'.png':'.jpg',base=String(value||'comprobante').normalize('NFKD').replace(/\.[A-Za-z0-9]{1,8}$/,'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,100)||'comprobante';return`${base}${extension}`}

async function handler(event){
 const auth=requireAdmin(event);if(!auth.ok)return auth.response;
 if(event.httpMethod!=='GET')return json(405,{message:'Method Not Allowed'});
 const reportId=String(event.queryStringParameters?.reportId||'').trim(),kind=String(event.queryStringParameters?.kind||'original').trim().toLowerCase();if(!validRecordId(reportId))return json(400,{message:'Reporte inválido.'});if(!['original','supplement'].includes(kind))return json(400,{message:'Tipo de comprobante inválido.'});
 try{
  connectLambdaEvent(event);
  const report=await airtableGetRecord(TABLES.reportes,reportId),fields=report?.fields||{},supplement=kind==='supplement',sha=String(fields[supplement?'Complemento SHA-256':'Hash SHA-256']||'').trim().toLowerCase(),contentType=String(fields[supplement?'Complemento MIME':'Comprobante MIME']||'').trim().toLowerCase(),blobKey=String(fields[supplement?'Complemento Blob Key':'Comprobante Blob Key']||'').trim();
  if(!/^[a-f0-9]{64}$/.test(sha)||!contentType)return json(404,{message:supplement?'El propietario no adjuntó un archivo adicional.':fields['Archivo Obligatorio']===false?'Este reporte corresponde a efectivo y no requiere captura.':'El reporte no tiene un comprobante almacenado.'});
  const store=createProofStore(),proof=blobKey?await store.getByKey({key:blobKey,attachmentSha:sha,contentType}):await store.get({reportId,attachmentSha:sha,contentType});
  if(!proof)return json(404,{message:'No se encontró el comprobante cifrado.'});
  const filename=safeFilename(fields[supplement?'Complemento Nombre Original':'Comprobante Nombre Original'],contentType);
  return{statusCode:200,isBase64Encoded:true,headers:{'Content-Type':contentType,'Content-Length':String(proof.content.length),'Content-Disposition':`inline; filename="${filename}"`,'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"},body:proof.content.toString('base64')};
 }catch(error){return json(503,{message:'No se pudo abrir el comprobante protegido.',detail:String(error?.code||error?.message||'').slice(0,200)})}
}

module.exports={handler,validRecordId,safeFilename};
