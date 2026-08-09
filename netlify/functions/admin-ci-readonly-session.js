'use strict';

const { issueAdminToken } = require('./_shared/_auth');
const { verifyGitHubOidcToken } = require('./_shared/_github_oidc');
const { loadConfigRecord } = require('./_shared/_admin_auth_store');

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

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { message: 'Solicitud inválida.' }); }
  const oidcToken = String(body.oidcToken || '');
  if (!oidcToken || oidcToken.length > 20000) return json(401, { message: 'Identidad CI no válida.' });
  try {
    const claims = await verifyGitHubOidcToken(oidcToken);
    const { config } = await loadConfigRecord({ force: true });
    const authVersion = Math.max(0, Number(config?.version || 0));
    const token = issueAdminToken({ role: 'admin-ci-readonly', ciRunId: claims.run_id, authVersion });
    return json(200, {
      success: true,
      token,
      role: 'admin-ci-readonly',
      expiresInMinutes: 20,
      source: 'github-oidc',
      passwordConfigVersion: authVersion
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'VLA_ADMIN_CI_OIDC_REJECTED', code: String(error.message || 'OIDC_REJECTED').slice(0, 80) }));
    return json(401, { success: false, message: 'Identidad CI no autorizada.' });
  }
};
