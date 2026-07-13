'use strict';

(() => {
  const prepared = new Map();
  const MAX_TEXT_LENGTH = 12000;

  function normalizeText(value) {
    return String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC');
  }
  function safeError(error) {
    return String(error && (error.message || error) || 'Error desconocido').replace(/[\r\n\t]/g, ' ').slice(0, 500);
  }
  async function sha256(text) {
    const bytes = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  }
  function bodyText() { return normalizeText(document.body && document.body.innerText || '').slice(0, 150000); }
  function qrVisible() {
    const selectors = ['canvas[aria-label*="Scan"]','canvas[aria-label*="scan"]','canvas[aria-label*="Escanea"]','div[data-ref] canvas'];
    return selectors.some(selector => [...document.querySelectorAll(selector)].some(visible));
  }
  function invalidRecipientVisible() {
    return /(phone number shared via url is invalid|n[uú]mero de tel[eé]fono.*no es v[aá]lido|el n[uú]mero de tel[eé]fono.*inv[aá]lido)/i.test(bodyText());
  }
  function composer() {
    const selectors = [
      'footer div[contenteditable="true"][role="textbox"]',
      'footer div[contenteditable="true"][data-tab]',
      'div[contenteditable="true"][role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][aria-placeholder]'
    ];
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].find(visible);
      if (found) return found;
    }
    return null;
  }
  function composerText(element = composer()) {
    return normalizeText(element && (element.innerText || element.textContent) || '');
  }
  function sendButton() {
    const direct = [
      'button[aria-label="Send"]','button[aria-label="Enviar"]','button[aria-label*="Send"]','button[aria-label*="Enviar"]'
    ];
    for (const selector of direct) {
      const found = [...document.querySelectorAll(selector)].find(element => visible(element) && !element.disabled);
      if (found) return found;
    }
    const icon = [...document.querySelectorAll('span[data-icon="send"], span[data-icon="send-filled"]')].find(visible);
    return icon && (icon.closest('button') || icon.closest('[role="button"]')) || null;
  }
  function currentPhone() {
    try { return new URL(location.href).searchParams.get('phone') || ''; }
    catch { return ''; }
  }
  function outgoingMatches(text) {
    const expected = normalizeText(text);
    const roots = [...document.querySelectorAll('[data-id^="true_"]')];
    const matches = [];
    for (const root of roots) {
      if (!visible(root)) continue;
      const actual = normalizeText(root.innerText || root.textContent || '');
      if (actual.includes(expected)) matches.push({ id: root.getAttribute('data-id') || '', text: actual });
    }
    return matches;
  }
  async function waitUntil(check, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await check();
        if (value) return value;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    if (lastError) throw lastError;
    return null;
  }
  async function status() {
    if (qrVisible()) return { ok: true, state: 'WHATSAPP_NOT_CONNECTED', connected: false };
    if (invalidRecipientVisible()) return { ok: true, state: 'INVALID_RECIPIENT', connected: true };
    const editor = composer();
    if (editor) return { ok: true, state: 'CHAT_READY', connected: true, composer: true };
    const app = document.querySelector('#app');
    if (app) return { ok: true, state: 'WHATSAPP_OPEN', connected: true, composer: false };
    return { ok: true, state: 'LOADING', connected: false };
  }
  async function prepare(command) {
    const attemptId = String(command.attemptId || '');
    const phone = String(command.phone || '');
    const text = normalizeText(command.text || '');
    const messageHash = String(command.messageHash || '');
    if (!/^[A-Za-z0-9._-]{8,100}$/.test(attemptId) || !/^\+[1-9]\d{7,14}$/.test(phone) || !text || text.length > MAX_TEXT_LENGTH || !/^[a-f0-9]{64}$/.test(messageHash)) {
      throw new Error('Datos de preparación inválidos.');
    }
    const localHash = await sha256(text);
    if (localHash !== messageHash) throw new Error('El texto recibido no coincide con el hash autorizado.');
    const digits = phone.replace(/\D/g, '');
    const ready = await waitUntil(async () => {
      if (qrVisible()) throw new Error('WHATSAPP_NOT_CONNECTED: escanee el código QR en Chrome.');
      if (invalidRecipientVisible()) throw new Error('INVALID_RECIPIENT: WhatsApp rechazó el número.');
      const editor = composer();
      if (!editor) return null;
      const actual = composerText(editor);
      if (actual !== text) return null;
      const urlPhone = currentPhone().replace(/\D/g, '');
      if (urlPhone !== digits) throw new Error('La URL activa no corresponde al destinatario solicitado.');
      return { editor, actual, urlPhone };
    }, 45000, 300);
    if (!ready) throw new Error('WhatsApp no cargó el editor con el texto exacto.');
    const baselineMatches = outgoingMatches(text);
    const baseline = { outgoingIds: baselineMatches.map(item => item.id).filter(Boolean), outgoingMatchCount: baselineMatches.length, composerHash: await sha256(ready.actual), urlPhone: ready.urlPhone };
    prepared.set(attemptId, { phone, text, messageHash, baseline, preparedAt: Date.now() });
    return { ok: true, prepared: true, state: 'PREPARED', chatPhoneMatch: true, composerExact: true, messageHash, baseline };
  }
  async function commit(command) {
    const attemptId = String(command.attemptId || '');
    const state = prepared.get(attemptId);
    if (!state) return { ok: true, status: 'verify', clicked: false, errorCode: 'PREPARATION_MISSING', error: 'La preparación no existe en la pestaña activa.' };
    if (Date.now() - state.preparedAt > 120000) {
      prepared.delete(attemptId);
      return { ok: true, status: 'verify', clicked: false, errorCode: 'PREPARATION_EXPIRED', error: 'La preparación expiró.' };
    }
    const editor = composer();
    const actual = composerText(editor);
    const actualHash = await sha256(actual);
    const digits = state.phone.replace(/\D/g, '');
    const urlPhone = currentPhone().replace(/\D/g, '');
    const chatPhoneMatch = digits === urlPhone;
    if (!editor || actualHash !== state.messageHash || !chatPhoneMatch) {
      prepared.delete(attemptId);
      return { ok: true, status: 'verify', clicked: false, errorCode: 'PRE_SEND_STATE_CHANGED', error: 'El destinatario o el texto cambió después de preparar.', evidence: { chatPhoneMatch, composerCleared: false, outgoingBubble: false, messageHash: actualHash } };
    }
    const button = sendButton();
    if (!button) {
      prepared.delete(attemptId);
      return { ok: true, status: 'verify', clicked: false, errorCode: 'SEND_CONTROL_MISSING', error: 'No se encontró el control de envío.', evidence: { chatPhoneMatch, composerCleared: false, outgoingBubble: false, messageHash: state.messageHash } };
    }
    const beforeIds = new Set(state.baseline.outgoingIds || []);
    const beforeCount = Number(state.baseline.outgoingMatchCount || 0);
    button.click();
    const evidence = await waitUntil(async () => {
      const cleared = composerText() === '';
      const matches = outgoingMatches(state.text);
      const newMatch = matches.find(item => item.id && !beforeIds.has(item.id));
      const outgoingBubble = Boolean(newMatch) || matches.length > beforeCount;
      if (cleared && outgoingBubble) return { composerCleared: true, outgoingBubble: true, outgoingId: newMatch && newMatch.id || '', chatPhoneMatch, messageHash: state.messageHash };
      return null;
    }, 30000, 300);
    prepared.delete(attemptId);
    if (evidence) return { ok: true, status: 'sent', clicked: true, evidence };
    const fallback = { composerCleared: composerText() === '', outgoingBubble: false, outgoingId: '', chatPhoneMatch, messageHash: state.messageHash };
    return { ok: true, status: 'verify', clicked: true, errorCode: 'SEND_CONFIRMATION_UNCERTAIN', error: 'Se activó Enviar, pero la burbuja saliente no pudo confirmarse.', evidence: fallback };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const run = async () => {
      if (!message || typeof message !== 'object') throw new Error('Orden interna inválida.');
      if (message.type === 'VLA_STATUS') return status();
      if (message.type === 'VLA_PREPARE') return prepare(message);
      if (message.type === 'VLA_COMMIT') return commit(message);
      throw new Error('Orden interna no reconocida.');
    };
    run().then(sendResponse).catch(error => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  });
})();
