const { withAirtableUsage } = require('./_airtable_meter');
// netlify/functions/access-auto-sync.js
// Sincronización automática/inteligente del acceso cómodo del portón.

const { requireAdmin } = require('./_auth');
const { json, syncOwnerAccess, autoSyncAll } = require('./_access_control');

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  try {
    if (body.ownerId) {
      const result = await syncOwnerAccess(body.ownerId, {
        reason: body.reason,
        forceMkj: body.forceMkj === true,
        sendEmail: body.sendEmail !== false
      });
      return json(200, { success: true, mode: 'owner', result });
    }

    const result = await autoSyncAll({
      forceMkj: body.forceMkj === true,
      sendEmail: body.sendEmail !== false
    });
    return json(200, { success: true, mode: 'all', ...result });
  } catch (error) {
    return json(500, { success: false, message: 'Error sincronizando accesos automáticamente.', detail: error.message });
  }
};

exports.handler = withAirtableUsage('access-auto-sync', handler);
