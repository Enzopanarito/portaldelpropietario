'use strict';

const nodemailer = require('nodemailer');
const { mkjLogin } = require('./_access_control');

const AUDIT_NONCE = 'vla-audit-7f4c2e91d8b6430ab31f';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

async function testAirtable() {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Variables Airtable incompletas.');
  const url = `https://api.airtable.com/v0/${encodeURIComponent(process.env.AIRTABLE_BASE_ID)}/${encodeURIComponent('Propietarios')}?maxRecords=1`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.records)) throw new Error(`Airtable HTTP ${response.status}`);
  return { ok:true, detail:'Lectura real correcta.' };
}

async function testSmtp() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_SECRET) throw new Error('Variables SMTP incompletas.');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_SECRET }
  });
  await transporter.verify();
  return { ok:true, detail:'Autenticación SMTP correcta; no se envió correo.' };
}

async function testMkj() {
  const result = await mkjLogin();
  return { ok:true, detail:`Login MKJ correcto, HTTP ${result.status}; no se modificó ningún usuario.` };
}

async function run(name, fn) {
  try { return { name, ...(await fn()) }; }
  catch (error) { return { name, ok:false, detail:String(error.message || error).slice(0,300) }; }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') return json(405, { message:'Method Not Allowed' });
  if (String(event.queryStringParameters?.audit || '') !== AUDIT_NONCE) return json(404, { message:'Not Found' });

  const checks = await Promise.all([
    run('Airtable', testAirtable),
    run('SMTP', testSmtp),
    run('MKJoules', testMkj)
  ]);
  const environment = {
    adminTokenSecretConfigured: Boolean(process.env.ADMIN_TOKEN_SECRET),
    adminTokenSecretIndependent: Boolean(process.env.ADMIN_TOKEN_SECRET) && process.env.ADMIN_TOKEN_SECRET !== process.env.ADMIN_PASSWORD,
    officialSmtpUser: String(process.env.SMTP_USER || '').trim().toLowerCase() === 'villalosapamates@gmail.com',
    mkjOrgConfigured: Boolean(process.env.MKJ_ORG_ID),
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY)
  };
  return json(checks.every(check => check.ok) && environment.adminTokenSecretIndependent ? 200 : 503, {
    ok: checks.every(check => check.ok) && environment.adminTokenSecretIndependent,
    readOnly:true,
    checks,
    environment,
    generatedAt:new Date().toISOString()
  });
};
