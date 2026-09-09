'use strict';

const crypto = require('node:crypto');

function clean(value) { return String(value || '').trim(); }
async function relayCommunication(action, payload = {}, timeoutMs = 20000) {
  const url = clean(process.env.VLA_WHATSAPP_CONTROL_URL);
  const secret = clean(process.env.VLA_WHATSAPP_CONTROL_SECRET);
  if (!/^https:\/\//i.test(url) || Buffer.byteLength(secret, 'utf8') < 32) {
    const error = new Error('El puente seguro hacia la Mac mini no está configurado.');
    error.code = 'WHATSAPP_CONTROL_NOT_CONFIGURED';
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'X-VLA-Control-Secret': secret,
        'User-Agent': 'VLA-Informational-Communications/1.0'
      },
      body: JSON.stringify({ action, payload, requestId: crypto.randomUUID(), requestedAt: new Date().toISOString() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(data.message || data.error || `Control WhatsApp HTTP ${response.status}`).slice(0, 300));
      error.status = response.status;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}

module.exports = { relayCommunication };
