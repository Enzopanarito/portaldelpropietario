'use strict';

const MARKER = 'GEMINI_DIRECT_SELFTEST_V3|2026-08-03T10:00Z';
const TABLE = 'ControlVersiones';
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash'];

function airtableEndpoint(query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`;
}

async function airtableRequest(query = '', options = {}) {
  const response = await fetch(airtableEndpoint(query), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
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
  const clean = value => String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
  const key = `${MARKER}|${success ? 'SUCCESS' : 'FAIL'}|HTTP_${Number(status) || 0}|MODEL_${clean(model || 'none')}|${clean(reason || 'UNKNOWN')}`;
  await airtableRequest('', {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields: { Key: key, Version: success ? 1 : 0 } }], typecast: true })
  });
}

async function geminiRequest(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Return only this exact text: VLA_GEMINI_DIRECT_OK' }] }],
        generationConfig: {
          maxOutputTokens: 256,
          thinkingConfig: { thinkingLevel: 'low' }
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map(part => String(part?.text || ''))
      .join('')
      .trim();
    return { response, payload, text };
  } finally {
    clearTimeout(timer);
  }
}

async function runTest() {
  if (!process.env.GEMINI_API_KEY) {
    await writeResult({ success: false, reason: 'MISSING_KEY' });
    return { success: false, reason: 'MISSING_KEY' };
  }

  const attempts = [];
  for (const model of MODELS) {
    const { response, payload, text } = await geminiRequest(model);
    if (response.ok && text.includes('VLA_GEMINI_DIRECT_OK')) {
      await writeResult({ success: true, status: response.status, model, reason: 'CONTENT_CONFIRMED' });
      return { success: true, status: response.status, model, reason: 'CONTENT_CONFIRMED' };
    }
    attempts.push(`${model}:${response.status}:${String(payload?.error?.status || payload?.candidates?.[0]?.finishReason || 'NO_OUTPUT')}`);
  }

  const reason = `FAILED_${attempts.join(',')}`;
  await writeResult({ success: false, model: 'multiple', reason });
  return { success: false, reason };
}

exports.handler = async function () {
  try {
    if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) {
      return { statusCode: 500, body: JSON.stringify({ success: false, reason: 'AIRTABLE_NOT_CONFIGURED' }) };
    }
    if (await markerAlreadyExists()) {
      return { statusCode: 200, body: JSON.stringify({ success: true, skipped: true }) };
    }
    const result = await runTest();
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
    return { statusCode: 500, body: JSON.stringify({ success: false, reason }) };
  }
};
