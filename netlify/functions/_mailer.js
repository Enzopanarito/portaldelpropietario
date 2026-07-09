const nodemailer = require('nodemailer');

const OFFICIAL_EMAIL = 'villalosapamates@gmail.com';
const OFFICIAL_FROM = `Villa Los Apamates <${OFFICIAL_EMAIL}>`;

function normalizeEmail(value = ''){
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}

function enabled(){
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_SECRET);
}

function senderIsOfficial(){
  const smtpUser = normalizeEmail(process.env.SMTP_USER);
  const mailFrom = normalizeEmail(process.env.MAIL_FROM);
  return smtpUser === OFFICIAL_EMAIL || mailFrom === OFFICIAL_EMAIL;
}

async function sendMail({to, subject, html, attachments}){
  if(!enabled()) return {sent:false,status:'Proveedor no configurado',detail:'Faltan variables SMTP en Netlify.'};
  if(!senderIsOfficial()) {
    return {
      sent:false,
      status:'Remitente inválido',
      detail:`El sistema está bloqueado para enviar solo desde ${OFFICIAL_EMAIL}. Revise SMTP_USER o MAIL_FROM en Netlify.`
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_SECRET }
  });

  const info = await transporter.sendMail({
    from: OFFICIAL_FROM,
    replyTo: OFFICIAL_EMAIL,
    to,
    subject,
    html,
    attachments: attachments || []
  });
  return {sent:true,status:'Enviado',detail:info.messageId || 'Enviado', from: OFFICIAL_EMAIL};
}

module.exports = { sendMail, enabled, OFFICIAL_EMAIL, OFFICIAL_FROM };
