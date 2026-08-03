'use strict';

exports.handler = async function () {
  const baseId = String(process.env.AIRTABLE_BASE_ID || '');
  const token = String(process.env.AIRTABLE_API_TOKEN || '');
  const result = {
    env: {
      baseIdPresent: Boolean(baseId),
      tokenPresent: Boolean(token),
      tokenLooksLikePat: /^pat[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(token),
      tokenLength: token.length
    },
    airtable: null
  };

  if (!baseId || !token) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result) };
  }

  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent('ControlVersiones')}?maxRecords=1`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    result.airtable = {
      ok: response.ok,
      status: response.status,
      errorType: data?.error?.type || null,
      errorMessage: data?.error?.message || data?.message || null,
      recordCount: Array.isArray(data?.records) ? data.records.length : null
    };
  } catch (error) {
    result.airtable = {
      ok: false,
      status: null,
      errorType: 'NETWORK_OR_RUNTIME_ERROR',
      errorMessage: String(error?.message || error).slice(0, 300),
      recordCount: null
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(result)
  };
};
