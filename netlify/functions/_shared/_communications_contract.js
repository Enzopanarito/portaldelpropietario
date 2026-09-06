'use strict';

const crypto = require('node:crypto');
const { cleanPlainText, escapeHtml } = require('./_security_utils');

const CHANNELS = new Set(['whatsapp', 'email']);
const NOTICE_LEVELS = new Set(['info', 'important', 'urgent', 'maintenance']);
const MAX_RECIPIENTS = 15;
const MAX_BODY = 2000;
const MAX_SUBJECT = 120;

function cleanMultiline(value, max = MAX_BODY) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .normalize('NFC')
    .replace(/<\/?(?:script|style|iframe|object|embed)[^>]*>/gi, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, max);
}

function normalizeChannels(value) {
  const channels = [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim().toLowerCase()))]
    .filter(item => CHANNELS.has(item));
  if (!channels.length) throw new Error('Seleccione WhatsApp, correo o ambos.');
  return channels;
}

function normalizeOwnerIds(value) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()))];
  if (!ids.length || ids.length > MAX_RECIPIENTS || ids.some(id => !/^rec[A-Za-z0-9]{14}$/.test(id))) {
    throw new Error('La selección de destinatarios no es válida.');
  }
  return ids;
}

function normalizeDraft(input = {}) {
  const subject = cleanPlainText(input.subject, MAX_SUBJECT);
  const body = cleanMultiline(input.body, MAX_BODY);
  if (subject.length < 4) throw new Error('El asunto debe tener al menos 4 caracteres.');
  if (body.length < 10) throw new Error('El comunicado debe tener al menos 10 caracteres.');
  return { subject, body };
}

function normalizeNotice(input = {}, now = new Date()) {
  const draft = normalizeDraft(input);
  const level = NOTICE_LEVELS.has(String(input.level || '').toLowerCase()) ? String(input.level).toLowerCase() : 'info';
  const publishedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { version: 1, active: true, level, title: draft.subject, body: draft.body, publishedAt, expiresAt };
}

function isNoticeActive(notice, now = new Date()) {
  return Boolean(notice && notice.active === true && Date.parse(notice.expiresAt || '') > now.getTime());
}

function jobIdFromRequest(requestId, now = new Date()) {
  const id = String(requestId || '').trim();
  if (!/^[0-9a-f-]{20,80}$/i.test(id)) throw new Error('Identificador de operación inválido.');
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `COM-${day}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12).toUpperCase()}`;
}

function money(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }

function expenseShare(expense, owner) {
  if (!expense) return 0;
  const fields = expense.fields || {};
  const ids = Array.isArray(fields.Propietarios) ? fields.Propietarios.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean) : [];
  if (ids.length && !ids.includes(owner.id)) return 0;
  const amount = money(fields.Monto);
  const type = typeof fields['Tipo de Gasto'] === 'object' ? fields['Tipo de Gasto']?.name : fields['Tipo de Gasto'];
  if (type === 'Gasto Común') return money(amount * Number(owner.Alicuota || 0));
  if (type === 'Gasto Especial' && ids.includes(owner.id)) return money(amount / Math.max(1, ids.length));
  return 0;
}

function replaceTokens(text, context) {
  return String(text || '')
    .replace(/\{\{\s*nombre\s*\}\}/gi, context.name)
    .replace(/\{\{\s*casa\s*\}\}/gi, String(context.house))
    .replace(/\{\{\s*monto\s*\}\}/gi, context.amount > 0 ? `$${context.amount.toFixed(2)}` : '');
}

function personalizedMessage({ jobId, subject, body, owner, expense }) {
  const house = Number(owner.Casa || owner.house || 0);
  const name = cleanPlainText(owner.Propietario || owner.name || `Propietario de la Casa ${house}`, 160);
  const amount = expenseShare(expense, owner);
  const context = { name, house, amount };
  const renderedBody = replaceTokens(body, context);
  const blocks = [
    `*${replaceTokens(subject, context)}*`,
    `Estimado(a) *${name}*:`,
    renderedBody
  ];
  if (expense && amount > 0 && !/\{\{\s*monto\s*\}\}/i.test(body)) {
    blocks.push(`Monto correspondiente a la Casa ${house}: *$${amount.toFixed(2)}*.`);
  }
  blocks.push('Para más información, consulte el Portal del Propietario:\nhttps://villalosapamates.netlify.app');
  blocks.push(`Referencia informativa: VLA-${jobId}-C${String(house).padStart(2, '0')}`);
  return cleanMultiline(blocks.join('\n\n'), 3500);
}

function emailDocument({ subject, message, house }) {
  const paragraphs = String(message || '').replace(/\*/g, '').split(/\n{2,}/).map(part => `<p style="margin:0 0 14px">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
  return `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55;max-width:680px;margin:auto">
    <p style="color:#177342;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase">Villa Los Apamates</p>
    <h2 style="color:#0f3d24">${escapeHtml(subject)}</h2>
    ${paragraphs}
    <p><a href="https://villalosapamates.netlify.app" style="display:inline-block;background:#0f6b36;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:bold">Abrir Portal del Propietario</a></p>
    <p style="font-size:12px;color:#64748b">Comunicado administrativo para la Casa ${Number(house || 0)}.</p>
  </div>`;
}

function publicNotice(notice, now = new Date()) {
  if (!isNoticeActive(notice, now)) return null;
  return { level: notice.level, title: cleanPlainText(notice.title, MAX_SUBJECT), body: cleanMultiline(notice.body, MAX_BODY), publishedAt: notice.publishedAt, expiresAt: notice.expiresAt };
}

module.exports = {
  CHANNELS, NOTICE_LEVELS, MAX_RECIPIENTS, MAX_BODY, MAX_SUBJECT,
  cleanMultiline, normalizeChannels, normalizeOwnerIds, normalizeDraft, normalizeNotice,
  isNoticeActive, jobIdFromRequest, expenseShare, personalizedMessage, emailDocument, publicNotice
};
