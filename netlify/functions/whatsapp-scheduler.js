// Ejecución programada en Netlify: solo crea órdenes; el Mac local realiza los envíos.
'use strict';
const { runSchedulerInternal } = require('./whatsapp-jobs');

exports.handler = async function() {
  try {
    const result = await runSchedulerInternal();
    return { statusCode:200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify({success:true,...result}) };
  } catch (error) {
    return { statusCode:500, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify({success:false,message:'Error ejecutando planificador WhatsApp.',detail:String(error.message||'').slice(0,500)}) };
  }
};
