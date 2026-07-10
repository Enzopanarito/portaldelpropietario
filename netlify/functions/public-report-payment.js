// netlify/functions/public-report-payment.js
// Endpoint público limitado para que propietarios reporten pagos sin exponer el proxy genérico.
// Al recibir un reporte suficiente para cubrir deuda vencida, habilita temporalmente el acceso cómodo.
// También notifica al correo de la urbanización para recibir alerta inmediata en el teléfono.
// Regla contable VLA: el monto reportado siempre es USD referencial. Si se selecciona Bs BCV,
// el sistema guarda el equivalente en bolívares multiplicando USD ref. x tasa BCV.
// Protección: bloquea durante 5 minutos reportes duplicados de la misma casa, monto, forma y referencia.

const { airtableCreateRecord, airtableGetRecord, syncOwnerAccess, TABLES, money } = require('./_access_control');
const { sendMail } = require('./_mailer');

const ALLOWED_MODES = new Set(['USD', 'Bs BCV']);
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

function todayCaracasISO(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Caracas',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function nowCaracasLabel(){return new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'medium',timeStyle:'short'}).format(new Date());}
function validRecordId(id){return /^rec[A-Za-z0-9]{14}$/.test(String(id||''));}
function fmtUsd(n){return '$'+money(n).toFixed(2)}
function fmtBs(n){return 'Bs. '+money(n).toLocaleString('es-VE',{minimumFractionDigits:2,maximumFractionDigits:2})}
function normalizeReference(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();}
function json(statusCode,body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate'},body:JSON.stringify(body)}}
function airtableUrl(tableName,query=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`}

async function loadRecentReports(){
  let records=[];
  let offset=null;
  do{
    const query='?pageSize=100'+(offset?`&offset=${encodeURIComponent(offset)}`:'');
    const response=await fetch(airtableUrl(TABLES.reportes,query),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error?.message||data.message||'Error verificando reportes recientes.');
    records=records.concat(data.records||[]);
    offset=data.offset;
  }while(offset);
  return records;
}

async function findRecentDuplicate({ownerId,mode,amount,reference}){
  const normalizedReference=normalizeReference(reference);
  const cutoff=Date.now()-DUPLICATE_WINDOW_MS;
  const reports=await loadRecentReports();
  return reports.find(report=>{
    const fields=report.fields||{};
    const owners=fields['Propietario que Reporta']||[];
    const createdAt=Date.parse(report.createdTime||'');
    const reportMode=String(fields['Forma de Pago Reportada']||'');
    const reportAmount=money(Number(fields['Equivalente USD Reportado']||fields['Monto Reportado']||0));
    const reportReference=normalizeReference(fields.Referencia||'');
    return Array.isArray(owners)&&owners.includes(ownerId)&&reportMode===mode&&Math.abs(reportAmount-amount)<=0.01&&reportReference===normalizedReference&&Number.isFinite(createdAt)&&createdAt>=cutoff;
  })||null;
}

async function notifyAdminPaymentReport({ownerId, mode, amount, usdEq, amountBs, reference, rate, reportId, access}) {
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.SMTP_USER || process.env.ADMIN_RECOVERY_EMAIL;
  if (!to) return { sent:false, status:'Sin correo administrador configurado' };

  let owner = null;
  try { owner = await airtableGetRecord(TABLES.propietarios, ownerId); } catch (_) { owner = null; }
  const f = owner && owner.fields ? owner.fields : {};
  const casa = f.Casa || '—';
  const propietario = f.Propietario || 'Propietario';
  const originalAmount = mode === 'Bs BCV' ? `${fmtUsd(amount)} ref. / ${fmtBs(amountBs || 0)}` : fmtUsd(amount);
  const rateText = mode === 'Bs BCV' && rate ? `<p><b>Tasa reportada:</b> ${money(rate).toFixed(2)} Bs/USD</p>` : '';
  const accessText = access && access.estado ? `${access.estado}${access.temporary ? ' temporal' : ''}` : (access && access.skipped ? access.reason : 'Sin información');

  return await sendMail({
    to,
    subject: `🚨 Pago reportado - Casa ${casa} - ${fmtUsd(usdEq)} ref.`,
    html: `
      <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.5">
        <h2 style="margin:0 0 10px;color:#0f3d24">🚨 Nuevo pago reportado</h2>
        <p>Se acaba de recibir un reporte de pago en el portal de propietarios.</p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:14px;margin:14px 0">
          <p><b>Casa:</b> ${casa}</p>
          <p><b>Propietario:</b> ${propietario}</p>
          <p><b>Forma de pago:</b> ${mode}</p>
          <p><b>Monto reportado:</b> ${originalAmount}</p>
          <p><b>Equivalente USD aplicado:</b> ${fmtUsd(usdEq)}</p>
          ${rateText}
          <p><b>Referencia:</b> ${reference}</p>
          <p><b>Fecha:</b> ${nowCaracasLabel()}</p>
          <p><b>Reporte:</b> ${reportId || '—'}</p>
          <p><b>Estado portón:</b> ${accessText}</p>
        </div>
        <p>Entra al panel administrativo para aprobar o rechazar el pago.</p>
        <p><a href="https://villalosapamates.netlify.app/admin.html" style="display:inline-block;background:#0f3d24;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Admin VLA</a></p>
      </div>`
  });
}

exports.handler=async function(event){
  const {AIRTABLE_API_TOKEN,AIRTABLE_BASE_ID}=process.env;
  if(event.httpMethod!=='POST')return json(405,{message:'Method Not Allowed'});
  if(!AIRTABLE_API_TOKEN||!AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});

  try{
    const body=JSON.parse(event.body||'{}');
    const ownerId=String(body.ownerId||'');
    const mode=String(body.mode||'');
    const reference=String(body.reference||'').trim().slice(0,120);
    const amount=money(Number(body.amount||0));
    const rate=Number(body.rate||0);

    if(!validRecordId(ownerId))return json(400,{message:'Propietario inválido.'});
    if(!ALLOWED_MODES.has(mode))return json(400,{message:'Forma de pago inválida.'});
    if(!(amount>0))return json(400,{message:'Monto inválido. Ingrese el monto en USD referencial.'});
    if(!reference)return json(400,{message:'Debe indicar referencia.'});
    if(mode==='Bs BCV'&&!(rate>0))return json(400,{message:'No hay tasa BCV disponible para calcular los bolívares.'});

    const duplicate=await findRecentDuplicate({ownerId,mode,amount,reference});
    if(duplicate){
      return json(409,{
        success:false,
        duplicate:true,
        retryAfterSeconds:300,
        message:'Este pago ya fue reportado recientemente. La administración se encuentra verificándolo. Espere al menos 5 minutos antes de intentar nuevamente.'
      });
    }

    const usdEq=amount;
    const amountBs=mode==='Bs BCV'?money(amount*rate):0;
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
      fields['Monto Reportado Bs']=amountBs;
      fields['Tasa BCV Reporte']=rate;
    }

    const report = await airtableCreateRecord(TABLES.reportes, fields);

    let access = null;
    try {
      access = await syncOwnerAccess(ownerId, {
        reason: 'Habilitación temporal por reporte de pago pendiente suficiente para deuda vencida.',
        sendEmail: false
      });
    } catch (error) {
      access = { error: error.message };
    }

    let adminNotification = null;
    try {
      adminNotification = await notifyAdminPaymentReport({ownerId, mode, amount, usdEq, amountBs, reference, rate, reportId: report&&report.id, access});
    } catch (error) {
      adminNotification = { sent:false, status:'Error enviando notificación admin', detail:error.message };
    }

    return json(200,{
      success:true,
      message:'Pago reportado correctamente. La administración verificará la información en un plazo no mayor de 72 horas.',
      reportId:report&&report.id,
      amountUsdRef:amount,
      amountBs,
      access,
      adminNotification
    });
  }catch(error){
    return json(500,{message:'Error guardando reporte.',detail:error.message});
  }
};