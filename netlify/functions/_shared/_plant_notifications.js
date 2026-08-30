'use strict';

const { sendMail } = require('./_mailer');
const { escapeHtml } = require('./_security_utils');
const { residentialServiceStatus } = require('./_plant_engine');

function clean(value) { return String(value ?? '').trim(); }
function yesNo(value) { return value ? 'Sí' : 'No'; }

async function sendPlantProfileChange({ owner, profile, previousProfile, portalUrl = 'https://villalosapamates.netlify.app/' }) {
  const to = clean(owner?.email);
  if (!to) return { sent: false, status: 'Correo no configurado', detail: 'El propietario no tiene Email ni MKJ Email.', recipientConfigured: false };
  const house = Number(owner?.house || profile?.house || 0);
  const name = escapeHtml(owner?.name || `Propietario de la Casa ${house}`);
  const state = escapeHtml(profile?.state || 'SIN ESTADO');
  const previousState = escapeHtml(previousProfile?.state || 'SIN ESTADO');
  const serviceStatus = residentialServiceStatus(profile);
  const subject = `Actualización de condición de planta · Casa ${house}`;
  const result = await sendMail({
    to,
    subject,
    html: `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55;max-width:680px;margin:auto">
      <p style="color:#177342;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase">Villa Los Apamates</p>
      <h2 style="color:#0f3d24">Actualización de su condición de planta</h2>
      <p>Estimado(a) ${name},</p>
      <p>Administración confirmó una actualización para la <b>Casa ${house}</b>, con vigencia desde <b>${escapeHtml(profile?.effectiveFrom || '')}</b>.</p>
      <table style="width:100%;border-collapse:collapse;margin:18px 0">
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Estado anterior</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${previousState}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Estado confirmado</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${state}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Reparaciones</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${yesNo(profile?.participaReparaciones)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Mantenimiento</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${yesNo(profile?.participaMantenimiento)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Gasoil residencial</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${yesNo(profile?.participaGasoilResidencial)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Modalidad con derecho a servicio</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${yesNo(profile?.servicioResidencialActivo)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #e2e8f0"><b>Estado visible en el portal</b></td><td style="padding:8px;border-bottom:1px solid #e2e8f0">${escapeHtml(serviceStatus.label)}</td></tr>
      </table>
      <p><b>Motivo administrativo:</b> ${escapeHtml(profile?.reason || '')}</p>
      <p>Este cambio crea una nueva versión de la condición de planta y <b>no recalcula gastos ni saldos anteriores</b>.</p>
      <p><a href="${escapeHtml(portalUrl)}" style="display:inline-block;background:#0f6b36;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Ver mi información de planta</a></p>
      <p style="font-size:12px;color:#64748b">Mensaje automático y auditable de Villa Los Apamates.</p>
    </div>`
  });
  return { ...result, recipientConfigured: true };
}

module.exports = { sendPlantProfileChange };
