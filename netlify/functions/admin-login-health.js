'use strict';

const { loadConfigRecord } = require('./_admin_auth_store');
const { getSecret, issueAdminToken, decodeAndVerifyAdminToken } = require('./_auth');

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, stage: 'method' });

  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    environment: {
      airtableToken: Boolean(process.env.AIRTABLE_API_TOKEN),
      airtableBase: Boolean(process.env.AIRTABLE_BASE_ID),
      sessionKeyConfigured: Boolean(process.env.ADMIN_SESSION_SIGNING_KEY),
      sessionSecretStrong: Boolean(getSecret())
    },
    config: null,
    token: null
  };

  try {
    const loaded = await loadConfigRecord({ force: true });
    report.config = {
      recordFound: Boolean(loaded?.record),
      parsed: Boolean(loaded?.config),
      passwordConfigured: Boolean(loaded?.config?.passwordHash || process.env.ADMIN_PASSWORD),
      algorithm: loaded?.config?.algorithm || loaded?.config?.algo || null,
      version: Number(loaded?.config?.version || 0)
    };
  } catch (error) {
    report.stage = 'airtable-config';
    report.error = String(error?.message || error).slice(0, 300);
    return json(500, report);
  }

  try {
    const token = issueAdminToken({ authVersion: report.config.version });
    const claims = decodeAndVerifyAdminToken(token);
    report.token = {
      issued: Boolean(token),
      verified: Boolean(claims),
      authVersion: Number(claims?.authVersion || 0)
    };
  } catch (error) {
    report.stage = 'session-token';
    report.error = String(error?.message || error).slice(0, 300);
    return json(500, report);
  }

  report.ok = Boolean(
    report.environment.airtableToken &&
    report.environment.airtableBase &&
    report.environment.sessionSecretStrong &&
    report.config?.recordFound &&
    report.config?.parsed &&
    report.config?.passwordConfigured &&
    report.token?.issued &&
    report.token?.verified
  );
  report.stage = report.ok ? 'ready' : 'incomplete';
  return json(report.ok ? 200 : 503, report);
};
