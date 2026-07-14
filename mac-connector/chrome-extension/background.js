'use strict';

const PORTAL_ORIGIN = 'https://villalosapamates.netlify.app';
const NATIVE_HOST = 'com.villaslosapamates.whatsapp_connector';
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';
const CONNECTOR_ENDPOINT = `${PORTAL_ORIGIN}/.netlify/functions/messaging-connector`;
const prepared = new Map();
const consumedCommits = new Set();
let activeDispatch = null;

function safeError(error) {
  return String(error && (error.message || error) || 'Error desconocido').replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
function authorizedSender(sender) {
  try { return new URL(sender && sender.url || '').origin === PORTAL_ORIGIN; }
  catch { return false; }
}
function validJobId(value) { return /^WA-[A-Z0-9-]{10,80}$/.test(String(value || '')); }
function validToken(value) { return typeof value === 'string' && value.length >= 80 && value.length <= 4096 && !/[\r\n]/.test(value); }
function validAttempt(value) { return /^[A-Za-z0-9._-]{8,100}$/.test(String(value || '')); }
function validPhone(value) { return /^\+?[1-9]\d{7,14}$/.test(String(value || '')); }
function validHash(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} agotó el tiempo de espera.`)), ms); })
  ]);
}
async function waitForTabComplete(tabId, timeoutMs = 60000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;
  return withTimeout(new Promise((resolve, reject) => {
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId !== tabId) return;
      if (changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).catch(error => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  }), timeoutMs, 'La carga de WhatsApp Web');
}
async function getWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: `${WHATSAPP_ORIGIN}/*` });
  if (tabs.length) {
    const ordered = tabs.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
    const keeper = ordered[0];
    const extras = ordered.slice(1).map(tab => tab.id).filter(Number.isInteger);
    if (extras.length) await chrome.tabs.remove(extras).catch(() => {});
    return { tab: keeper, closedExtraTabs: extras.length };
  }
  const tab = await chrome.tabs.create({ url: WHATSAPP_ORIGIN, active: true });
  return { tab, closedExtraTabs: 0 };
}
async function sendTabMessage(tabId, message, timeoutMs = 30000) {
  let lastError;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
  }
  throw lastError || new Error('El contenido de WhatsApp Web no respondió.');
}
async function prepareWhatsApp(command) {
  const attemptId = String(command.attemptId || '');
  const phone = String(command.phone || '');
  const text = String(command.text || '');
  const messageHash = String(command.messageHash || '');
  if (!validAttempt(attemptId) || !validPhone(phone) || !text.trim() || text.length > 12000 || !validHash(messageHash)) {
    throw new Error('La orden de preparación contiene datos inválidos.');
  }
  if (consumedCommits.has(attemptId)) throw new Error('Este intento ya consumió su autorización de envío.');
  const digits = phone.replace(/\D/g, '');
  const { tab, closedExtraTabs } = await getWhatsAppTab();
  const targetUrl = `${WHATSAPP_ORIGIN}/send?phone=${encodeURIComponent(digits)}&text=${encodeURIComponent(text)}&app_absent=0`;
  await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
  await waitForTabComplete(tab.id, 60000);
  const result = await sendTabMessage(tab.id, { type: 'VLA_PREPARE', attemptId, phone: `+${digits}`, text, messageHash }, 45000);
  if (!result || result.ok !== true || result.prepared !== true) throw new Error(result && result.error || 'WhatsApp no confirmó la preparación.');
  prepared.set(attemptId, { tabId: tab.id, messageHash, phone: `+${digits}`, preparedAt: Date.now(), baseline: result.baseline || {} });
  return { ...result, closedExtraWhatsAppTabs: closedExtraTabs };
}
async function commitWhatsApp(command) {
  const attemptId = String(command.attemptId || '');
  if (!validAttempt(attemptId)) throw new Error('Intento inválido.');
  if (consumedCommits.has(attemptId)) return { ok: true, status: 'verify', clicked: false, errorCode: 'COMMIT_ALREADY_CONSUMED', error: 'La autorización de clic ya fue consumida; no se repetirá el envío.' };
  const state = prepared.get(attemptId);
  if (!state) return { ok: true, status: 'failed', clicked: false, errorCode: 'PREPARATION_MISSING', error: 'No existe una preparación activa para este intento.' };
  if (Date.now() - state.preparedAt > 120000) {
    prepared.delete(attemptId);
    return { ok: true, status: 'failed', clicked: false, errorCode: 'PREPARATION_EXPIRED', error: 'La preparación expiró antes de confirmar el envío.' };
  }

  // Consumir en memoria antes de hablar con la pestaña. Una caída o timeout posterior
  // se clasifica como incierto y jamás habilita un segundo clic automático.
  prepared.delete(attemptId);
  consumedCommits.add(attemptId);
  if (consumedCommits.size > 200) consumedCommits.delete(consumedCommits.values().next().value);
  try {
    const result = await sendTabMessage(state.tabId, { type: 'VLA_COMMIT', attemptId, messageHash: state.messageHash, phone: state.phone, baseline: state.baseline }, 45000);
    if (!result || result.ok !== true) return { ok: true, status: 'verify', clicked: true, errorCode: 'COMMIT_RESPONSE_UNCERTAIN', error: result && result.error || 'WhatsApp no confirmó el resultado después de consumir el clic.' };
    return result;
  } catch (error) {
    return { ok: true, status: 'verify', clicked: true, errorCode: 'COMMIT_TIMEOUT_OR_DISCONNECT', error: safeError(error), evidence: { chatPhoneMatch: false, composerCleared: false, outgoingBubble: false, messageHash: state.messageHash } };
  }
}
function nativeHealth() {
  return withTimeout(new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      fn(value);
    };
    port.onMessage.addListener(message => {
      if (message && message.type === 'health_result') finish(resolve, message);
    });
    port.onDisconnect.addListener(() => {
      if (!settled) finish(reject, new Error(chrome.runtime.lastError && chrome.runtime.lastError.message || 'El host nativo no está disponible.'));
    });
    port.postMessage({ type: 'health', protocol: 1 });
  }), 7000, 'La comprobación del conector');
}
function validateDispatch(message) {
  if (!message || message.type !== 'VLA_DISPATCH') throw new Error('Orden externa inválida.');
  if (!validJobId(message.jobId) || !validToken(message.dispatchToken)) throw new Error('El permiso de despacho es inválido.');
  if (!['Simulación', 'Envío real'].includes(message.mode)) throw new Error('Modo de despacho inválido.');
  return { jobId: message.jobId, dispatchToken: message.dispatchToken, mode: message.mode };
}
function startNativeDispatch(command, externalPort) {
  if (activeDispatch) throw new Error('Ya existe un lote activo en este navegador.');
  const nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  const dispatch = { jobId: command.jobId, nativePort, externalPort, closed: false };
  activeDispatch = dispatch;
  const close = reason => {
    if (dispatch.closed) return;
    dispatch.closed = true;
    if (activeDispatch === dispatch) activeDispatch = null;
    try { nativePort.disconnect(); } catch {}
    if (reason) {
      try { externalPort.postMessage({ type: 'VLA_ERROR', jobId: command.jobId, error: safeError(reason) }); } catch {}
    }
  };
  nativePort.onMessage.addListener(async message => {
    try {
      if (!message || typeof message !== 'object') throw new Error('Mensaje nativo inválido.');
      if (message.type === 'prepare_message') {
        const result = await prepareWhatsApp(message);
        nativePort.postMessage({ type: 'prepare_result', requestId: message.requestId, ok: true, result });
        externalPort.postMessage({ type: 'VLA_PROGRESS', jobId: command.jobId, stage: 'prepared', house: message.house });
        return;
      }
      if (message.type === 'commit_message') {
        const result = await commitWhatsApp(message);
        nativePort.postMessage({ type: 'commit_result', requestId: message.requestId, ok: true, result });
        externalPort.postMessage({ type: 'VLA_PROGRESS', jobId: command.jobId, stage: result.status || 'unknown', house: message.house });
        return;
      }
      if (message.type === 'progress') {
        externalPort.postMessage({ type: 'VLA_PROGRESS', jobId: command.jobId, ...message.payload });
        return;
      }
      if (message.type === 'dispatch_complete') {
        externalPort.postMessage({ type: 'VLA_COMPLETE', jobId: command.jobId, result: message.result || {} });
        close();
        return;
      }
      if (message.type === 'dispatch_error') {
        externalPort.postMessage({ type: 'VLA_ERROR', jobId: command.jobId, error: safeError(message.error) });
        close();
      }
    } catch (error) {
      if (message && message.requestId) nativePort.postMessage({ type: `${message.type || 'request'}_result`, requestId: message.requestId, ok: false, error: safeError(error) });
      else close(error);
    }
  });
  nativePort.onDisconnect.addListener(() => {
    if (!dispatch.closed) close(chrome.runtime.lastError && chrome.runtime.lastError.message || 'El host nativo se desconectó.');
  });
  externalPort.onDisconnect.addListener(() => close());
  nativePort.postMessage({ type: 'dispatch', protocol: 1, endpoint: CONNECTOR_ENDPOINT, ...command });
  externalPort.postMessage({ type: 'VLA_ACCEPTED', jobId: command.jobId });
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!authorizedSender(sender)) {
    sendResponse({ ok: false, error: 'Origen no autorizado.' });
    return false;
  }
  if (!message || message.type !== 'VLA_HEALTH') {
    sendResponse({ ok: false, error: 'Solicitud no reconocida.' });
    return false;
  }
  nativeHealth().then(result => sendResponse({ ok: true, extension: true, native: result })).catch(error => sendResponse({ ok: false, extension: true, native: false, error: safeError(error) }));
  return true;
});

chrome.runtime.onConnectExternal.addListener(port => {
  if (!authorizedSender(port.sender) || port.name !== 'vla-whatsapp-admin') {
    try { port.disconnect(); } catch {}
    return;
  }
  port.onMessage.addListener(message => {
    try {
      if (message && message.type === 'VLA_CANCEL_LOCAL') {
        if (activeDispatch && activeDispatch.externalPort === port) {
          activeDispatch.nativePort.postMessage({ type: 'cancel_local' });
        }
        return;
      }
      startNativeDispatch(validateDispatch(message), port);
    } catch (error) {
      port.postMessage({ type: 'VLA_ERROR', error: safeError(error) });
    }
  });
});
