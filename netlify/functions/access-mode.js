// netlify/functions/access-mode.js
// Lee o actualiza el modo del control de acceso del portón: Automático / Manual.

const { requireAdminCurrent } = require('./_auth');
const { json, getAccessMode, setAccessMode, ACCESS_MODE_AUTO, ACCESS_MODE_MANUAL } = require('./_access_control');

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;

  try {
    if (event.httpMethod === 'GET') {
      const current = await getAccessMode();
      return json(200, { success: true, mode: current.mode });
    }

    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
    const requested = String(body.mode || '').trim();
    const mode = requested === ACCESS_MODE_MANUAL ? ACCESS_MODE_MANUAL : ACCESS_MODE_AUTO;
    const updated = await setAccessMode(mode);

    return json(200, {
      success: true,
      mode: updated.mode,
      message: updated.mode === ACCESS_MODE_AUTO
        ? 'Control automático del portón activado.'
        : 'Control automático del portón pausado. El sistema queda en modo manual.'
    });
  } catch (error) {
    return json(500, { success: false, message: 'Error consultando o actualizando modo del portón.', detail: error.message });
  }
};