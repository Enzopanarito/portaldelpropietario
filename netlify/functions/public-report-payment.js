// netlify/functions/public-report-payment.js
// Endpoint público limitado para que propietarios reporten pagos sin exponer el proxy genérico.
// Al recibir un reporte suficiente para cubrir deuda vencida, habilita temporalmente el acceso cómodo.

const { airtableCreateRecord, syncOwnerAccess, TABLES, money } = require('./_access_control');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
function todayCaracasISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}

exports.handler=async function(event){
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  if(event.httpMethod!=='POST')return{statusCode:405,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Method Not Allowed'})};
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return{statusCode:500,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Airtable no está configurado.'})};

  try{
    const body=JSON.parse(event.body||'{}');
    const ownerId=String(body.ownerId||'');
    const mode=String(body.mode||'');
    const reference=String(body.reference||'').trim().slice(0,120);
    const amount=Number(body.amount||0);
    const rate=Number(body.rate||0);

    if(!validRecordId(ownerId))return{statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Propietario inválido.'})};
    if(!ALLOWED_MODES.has(mode))return{statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Forma de pago inválida.'})};
    if(!(amount>0))return{statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Monto inválido.'})};
    if(!reference)return{statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'Debe indicar referencia.'})};

    const usdEq=mode==='Bs BCV'?(rate>0?money(amount/rate):0):money(amount);
    const fields={
      'Propietario que Reporta':[ownerId],
      'Monto Reportado':usdEq,
      Referencia:reference,
      Estado:'Pendiente',
      'Fecha del Reporte':todayCaracasISO(),
      'Forma de Pago Reportada':mode,
      'Equivalente USD Reportado':usdEq
    };
    if(mode==='Bs BCV'){
      fields['Monto Reportado Bs']=money(amount);
      fields['Tasa BCV Reporte']=rate;
    }

    const report = await airtableCreateRecord(TABLES.reportes, fields);

    // Habilitación temporal solo si los reportes pendientes cubren TODA la deuda vencida previa.
    let access = null;
    try {
      access = await syncOwnerAccess(ownerId, {
        reason: 'Habilitación temporal por reporte de pago pendiente suficiente para deuda vencida.',
        sendEmail: false
      });
    } catch (error) {
      access = { error: error.message };
    }

    return{statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({success:true,message:'Reporte recibido. Será verificado por administración.',reportId:report&&report.id,access})};
  }catch(error){
    return{statusCode:500,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({message:'Error guardando reporte.',detail:error.message})};
  }
};