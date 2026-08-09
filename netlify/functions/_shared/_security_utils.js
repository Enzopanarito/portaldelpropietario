'use strict';

// Utilidades compartidas para impedir que textos de Airtable o formularios
// se conviertan en HTML/JavaScript al mostrarse en el portal o el admin.

function stripControlChars(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function cleanPlainText(value, maxLength = 500) {
  const max = Number.isFinite(Number(maxLength)) ? Math.max(1, Number(maxLength)) : 500;
  return stripControlChars(value)
    .normalize('NFC')
    .replace(/[<>]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function escapeHtml(value) {
  return stripControlChars(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function safeDisplayText(value, maxLength = 2000) {
  const max = Number.isFinite(Number(maxLength)) ? Math.max(1, Number(maxLength)) : 2000;
  return escapeHtml(stripControlChars(value).normalize('NFC').slice(0, max));
}

function sanitizeReference(value) {
  return cleanPlainText(value, 120);
}

function deepEscapeStrings(value, maxStringLength = 4000) {
  if (typeof value === 'string') return safeDisplayText(value, maxStringLength);
  if (Array.isArray(value)) return value.map(item => deepEscapeStrings(item, maxStringLength));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = deepEscapeStrings(item, maxStringLength);
    }
    return out;
  }
  return value;
}

module.exports = {
  stripControlChars,
  cleanPlainText,
  escapeHtml,
  safeDisplayText,
  sanitizeReference,
  deepEscapeStrings
};
