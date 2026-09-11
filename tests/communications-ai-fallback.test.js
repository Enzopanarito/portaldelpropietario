'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { improveCommunication } = require('../netlify/functions/_shared/_communications_ai');
const { clearMemoryCache } = require('../netlify/functions/_shared/_payment_ai_model_discovery');

function memoryStore() {
  const rows = new Map();
  return {
    async get(key, options) {
      const value = rows.get(key);
      if (!value) return null;
      return options?.type === 'json' ? structuredClone(value) : JSON.stringify(value);
    },
    async setJSON(key, value) { rows.set(key, structuredClone(value)); }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('comunicaciones cambia automáticamente a un Gemini compatible cuando el configurado devuelve 404', async () => {
  clearMemoryCache();
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/models/gemini-retirado:generateContent')) {
      return jsonResponse({ error: { status: 'NOT_FOUND', message: 'models/gemini-retirado is not found' } }, 404);
    }
    if (String(url).includes('/v1beta/models?pageSize=1000')) {
      return jsonResponse({ models: [
        { name: 'models/gemini-2.5-flash-lite', baseModelId: 'gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', baseModelId: 'text-embedding-004', supportedGenerationMethods: ['embedContent'] }
      ] });
    }
    if (String(url).includes('/models/gemini-2.5-flash-lite:generateContent')) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ subject: 'Motor del portón eléctrico', body: 'Informamos que la compra está pendiente de disponibilidad por parte del distribuidor.' }) }] } }] });
    }
    throw new Error(`URL inesperada: ${url}`);
  };

  const result = await improveCommunication(
    { subject: 'motor', body: 'todavia no se compra porque no hay disponibilidad' },
    { apiKey: 'fixture-api-key', model: 'gemini-retirado', fetchFn, storeFactory: async () => memoryStore() }
  );

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.requestedModel, 'gemini-retirado');
  assert.equal(result.model, 'gemini-2.5-flash-lite');
  assert.equal(result.subject, 'Motor del portón eléctrico');
  assert.equal(calls.filter(url => url.includes(':generateContent')).length, 2);
  assert.equal(calls.filter(url => url.includes('pageSize=1000')).length, 1);
});

test('un límite 429 conserva un error claro y no consulta el catálogo innecesariamente', async () => {
  clearMemoryCache();
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    return jsonResponse({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429);
  };

  await assert.rejects(
    improveCommunication(
      { subject: 'Aviso', body: 'Texto de prueba suficientemente largo.' },
      { apiKey: 'fixture-api-key-rate', model: 'gemini-2.5-flash', fetchFn, storeFactory: async () => memoryStore() }
    ),
    error => error.code === 'RATE_LIMIT' && /límite de solicitudes/i.test(error.message)
  );
  assert.equal(calls.length, 1);
});

test('si el catálogo no ofrece una alternativa distinta, el mensaje original queda protegido con error explícito', async () => {
  clearMemoryCache();
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes(':generateContent')) {
      return jsonResponse({ error: { status: 'NOT_FOUND', message: 'model not found' } }, 404);
    }
    return jsonResponse({ models: [
      { name: 'models/gemini-2.5-flash', baseModelId: 'gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
    ] });
  };

  await assert.rejects(
    improveCommunication(
      { subject: 'Aviso', body: 'Este contenido no debe perderse aunque la IA falle.' },
      { apiKey: 'fixture-api-key-same', model: 'gemini-2.5-flash', fetchFn, storeFactory: async () => memoryStore() }
    ),
    error => error.code === 'AI_MODEL_NOT_FOUND' && /compatible/i.test(error.message)
  );
  assert.equal(calls.filter(url => url.includes(':generateContent')).length, 1);
  assert.equal(calls.filter(url => url.includes('pageSize=1000')).length, 1);
});
