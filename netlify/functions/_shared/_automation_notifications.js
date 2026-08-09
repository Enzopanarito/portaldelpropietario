'use strict';

const {sendMail}=require('./_mailer');

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character])}
function money(value){return Math.round(Number(value||0)*100)/100}
function debtText(calc,type='restriction'){
 const due=type==='due',usd=calc?.outstandingUsd,bs=calc?.outstandingBsRef;
 const parts=[];if(Number(usd)>0.01)parts.push(`USD $${money(usd).toFixed(2)}`);if(Number(bs)>0.01)parts.push(`Bs ref. $${money(bs).toFixed(2)}`);return parts.join(' y ')||(due?'sin saldo pendiente':'sin deuda vencida');
}
async function sendOwnerDebtReminder({owner,calc,cycle,type='due'}){
 const fields=owner?.fields||{},to=fields.Email||fields['MKJ Email'];if(!to)return{sent:false,status:'Sin correo'};
 const name=escapeHtml(fields.Propietario||'propietario(a)'),house=escapeHtml(fields.Casa||''),isRestriction=type==='restriction';
 const subject=isRestriction?`Aviso de cierre mensual y portón - Casa ${house}`:`Recordatorio de pronto pago - Casa ${house}`;
 const headline=isRestriction?'Se acerca el cierre mensual':'Se acerca el fin del pronto pago';
 const primaryDate=isRestriction?cycle.restrictionDate:cycle.dueDate;
  return sendMail({to,subject,html:`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55;max-width:680px;margin:auto"><h2 style="color:#0f3d24">${headline}</h2><p>Estimado(a) ${name},</p><p>La cuenta de la Casa ${house} presenta un saldo pendiente por <b>${escapeHtml(debtText(calc,type))}</b>.</p><p>Fecha relevante: <b>${escapeHtml(primaryDate)}</b>. ${isRestriction?'Al cambiar el mes, únicamente el saldo pendiente del mes que termina pasará a deuda vencida y podrá limitar automáticamente el acceso cómodo mediante control o aplicación. La cuota nueva no se toma en cuenta para esa decisión y el acceso peatonal o alternativo no se elimina.':'El beneficio de pronto pago se mantiene hasta esta fecha. Después puede aplicarse el ajuste corriente previsto, pero la cuota no se considera deuda vencida hasta el cierre mensual.'}</p><p>Un reporte queda en verificación hasta que el sistema o la administración confirme que el monto, la referencia, el receptor y el comprobante coinciden.</p><p><a href="https://villalosapamates.netlify.app/" style="display:inline-block;background:#0f6b36;color:white;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Portal del Propietario</a></p><p style="font-size:12px;color:#64748b">Mensaje automático y auditable de Villa Los Apamates.</p></div>`});
}
async function sendAdminAutopilotAlert({subject='Piloto automático requiere revisión',summary,details=[]}={}){
 const to=process.env.ADMIN_NOTIFY_EMAIL||process.env.SMTP_USER||process.env.ADMIN_RECOVERY_EMAIL;if(!to)return{sent:false,status:'Sin correo administrador'};
 const rows=(details||[]).map(item=>`<li><b>${escapeHtml(item.code||'REVISIÓN')}:</b> ${escapeHtml(item.detail||item.message||'')}</li>`).join('');
 return sendMail({to,subject:`⚠️ ${subject}`,html:`<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55"><h2 style="color:#9a3412">${escapeHtml(subject)}</h2><p>${escapeHtml(summary||'El sistema detuvo una acción automática para proteger la información financiera.')}</p>${rows?`<ul>${rows}</ul>`:''}<p>No se ejecutó ninguna decisión financiera insegura.</p><p><a href="https://villalosapamates.netlify.app/admin.html" style="display:inline-block;background:#0f3d24;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir administración</a></p></div>`});
}

module.exports={escapeHtml,money,debtText,sendOwnerDebtReminder,sendAdminAutopilotAlert};
