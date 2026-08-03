'use strict';

const MARKER = 'GEMINI_DIRECT_SELFTEST_V2|2026-08-03T09:55Z';
const TABLE = 'ControlVersiones';
const PREFERRED_MODELS = [
  'models/gemini-3.6-flash',
  'models/gemini-3.5-flash',
  'models/gemini-2.5-flash',
  'models/gemini-2.5-flash-lite'
];

function airtableEndpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function airtableRequest(query = '', options = {}) {
  const response = await fetch(airtableEndpoint(query), {
    ...options,
    headers: { ...airtableHeaders(), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AIRTABLE_${response.status}`);
  return data;
}

async function markerAlreadyExists() {
  const formula = `LEFT({Key}, ${MARKER.length})='${MARKER}'`;
  const params = new URLSearchParams({ maxRecords: '1', filterByFormula: formula });
  const data = await airtableRequest(`?${params.toString()}`);
  return Array.isArray(data.records) && data.records.length > 0;
}

async function writeResult({ success, status = 0, model = '', reason = '' }) {
  const safeModel = String(model || 'none').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const safeReason = String(reason || (success ? 'OK' : 'UNKNOWN')).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180);
  const key = `${MARKER}|${success ? 'SUCCESS' : 'FAIL'}|HTTP_${Number(status) || 0}|MODEL_${safeModel}|${safeReason}`;
  await airtableRequest('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: { Key: key, Version: success ? 1 : 0 } }], typecast: true })
  });
}

async function googleRequest(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function responseText(payload) {
  return (payload?.candidates?.[0]?.content?.parts || [])
    .map(part => String(part?.text || ''))
    .join('')
    .trim();
}

function errorLabel(payload, fallback) {
  const code = String(payload?.error?.status || '').trim();
  const message = String(payload?.error?.message || '').trim();
  return `${fallback}_${code}_${message}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
}

async function runDirectTest() {
  if (!process.env.GEMINI_API_KEY) {
    await writeResult({ success: false, reason: 'MISSING_KEY' });
    return { success: false, reason: 'MISSING_KEY' };
  }

  const modelsResponse = await googleRequest('https://generativelanguage.googleapis.com/v1beta/models');
  const modelsPayload = await modelsResponse.json().catch(() => ({}));
  if (!modelsResponse.ok) {
    const reason = errorLabel(modelsPayload, 'MODEL_DISCOVERY_FAILED');
    await writeResult({ success: false, status: modelsResponse.status, reason });
    return { success: false, status: modelsResponse.status, reason };
  }

  const available = Array.isArray(modelsPayload.models) ? modelsPayload.models : [];
  const eligible = available.filter(model =>
    Array.isArray(model.supportedGenerationMethods) &&
    model.supportedGenerationMethods.includes('generateContent') &&
    /^models\/gemini/i.test(String(model.name || ''))
  );
  const ordered = [
    ...PREFERRED_MODELS.filter(name => eligible.some(model => model.name === name)),
    ...eligible.map(model => model.name)
  ].filter((name, index, all) => all.indexOf(name) === index).slice(0, 8);

  if (!ordered.length) {
    await writeResult({ success: false, status: 200, reason: 'NO_GENERATE_CONTENT_MODEL' });
    return { success: false, status: 200, reason: 'NO_GENERATE_CONTENT_MODEL' };
  }

  const attempts = [];
  for (const selected of ordered) {
    const response = await googleRequest(`https://generativelanguage.googleapis.com/v1beta/${selected}:generateContent`, {
      method: 'POST',
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply exactly with: VLA_GEMINI_DIRECT_OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 32 }
      })
    });
    const payload = await response.json().catch(() => ({}));
    const text = responseText(payload);
    const success = response.ok && text.includes('VLA_GEMINI_DIRECT_OK');
    const shortModel = selected.replace(/^models\//, '');
    if (success) {
      await writeResult({ success: true, status: response.status, model: shortModel, reason: 'CONTENT_CONFIRMED' });
      return { success: true, status: response.status, model: selected, reason: 'CONTENT_CONFIRMED' };
    }
    attempts.push(`${shortModel}:${response.status}:${String(payload?.error?.status || 'NO_OUTPUT')}`);
  }

  const reason = `ALL_MODELS_FAILED_${attempts.join(',')}`;
  await writeResult({ success: false, status: 0, model: 'multiple', reason });
  return { success: false, status: 0, model: 'multiple', reason };
}

exports.handler = async function () {
  try {
    if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      return { statusCode: 500, body: JSON.stringify({ success: false, reason: 'AIRTABLE_NOT_CONFIGURED' }) };
    }
    if (await markerAlreadyExists()) {
      return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true }) };
    }
    const result = await runDirectTest();
    return {
      statusCode: result.success ? 200 : 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(result)
    };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'TIMEOUT' : String(error?.message || 'SELFTEST_ERROR').slice(0, 100);
    try {
      if (!(await markerAlreadyExists())) await writeResult({ success: false, reason });
    } catch (_) {}
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ success: false, reason })
    };
  }
};
