const nodemailer = require('nodemailer');

function enabled(){
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_SECRET);
}

async function sendMail({to, subject, html}){
  if(!enabled()) return {sent:false,status:'Proveedor no configurado',detail:'Faltan variables SMTP en Netlify.'};
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_SECRET }
  });
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const info = await transporter.sendMail({from, to, subject, html});
  return {sent:true,status:'Enviado',detail:info.messageId || 'Enviado'};
}

module.exports = { sendMail, enabled };
