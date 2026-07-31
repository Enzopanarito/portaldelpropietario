'use strict';

// La ruta pública experimental fue retirada. El análisis de comprobantes se ejecuta
// únicamente dentro del flujo financiero protegido y nunca expone ni registra la clave.

const {requireAdmin}=require('./_auth');

exports.handler=async function(event){
 const auth=requireAdmin(event);
 if(!auth.ok)return auth.response;
 if(event.httpMethod!=='GET')return{statusCode:405,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({message:'Method Not Allowed'})};
 return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},body:JSON.stringify({available:Boolean(process.env.GEMINI_API_KEY),mode:'internal-payment-proof-extraction',publicPrompting:false})};
};
