'use strict';

const { requireAdminCurrent } = require('./_auth');
const { loadConfigRecord } = require('./_admin_auth_store');

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
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { message: 'Method Not Allowed' });

  try {
    const { record, config } = await loadConfigRecord({ force: true });
    const storedPassword = Boolean(config?.salt && config?.hash && config?.algorithm === 'scrypt-v1');
    return json(200, {
      success: true,
      storedPassword,
      authVersion: Number(config?.version || 0),
      recoveryConfigured: Boolean(config?.recoveryEmail || process.env.ADMIN_RECOVERY_EMAIL),
      recordId: record?.id || null,
      algorithm: config?.algorithm || (storedPassword ? 'scrypt-v1' : null),
      fallbackPasswordConfigured: Boolean(process.env.ADMIN_PASSWORD),
      tokenSecretConfigured: Boolean(process.env.ADMIN_TOKEN_SECRET)
    });
  } catch (error) {
    return json(500, { success:false, message:'No se pudo consultar el estado de credenciales.', detail:error.message });
  }
};
