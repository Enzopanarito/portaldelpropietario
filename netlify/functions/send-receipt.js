const { withAirtableUsage } = require('./_airtable_meter');
// netlify/functions/send-receipt.js
// Crea comprobantes de pago y, si hay proveedor configurado, los envía por correo con PDF adjunto.
// Esta función queda como endpoint manual; el servicio real está centralizado en _receipt_service.

const { requireAdmin } = require('./_auth');
const { createAndSendReceipt } = require('./_receipt_service');

function json(statusCode, body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}

const handler = async function(event){
  const auth=requireAdmin(event); if(!auth.ok)return auth.response;
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  try{
    const body=JSON.parse(event.body||'{}');
    const result = await createAndSendReceipt(body);
    return json(200,result);
  }catch(error){return json(500,{message:'Error generando comprobante.',detail:error.message});}
};

exports.handler = withAirtableUsage('send-receipt', handler);
