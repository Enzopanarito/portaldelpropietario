'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const { safeDisplayText } = require('./_shared/_security_utils');
const { requireVlaAiService } = require('./_shared/_vla_ai_service_auth');
const { buildVlaAiContext } = require('./_shared/_vla_ai_context');

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};
function json(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }

function createHandler(deps = {}) {
  const authenticate = deps.requireVlaAiService || requireVlaAiService;
  const buildContext = deps.buildVlaAiContext || buildVlaAiContext;
  return async function handler(event) {
    const auth = authenticate(event);
    if (!auth.ok) return auth.response;
    if (String(event.httpMethod || '').toUpperCase() !== 'POST') return json(405, { success: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return json(400, { success: false, code: 'INVALID_JSON', message: 'Solicitud JSON inválida.' }); }
    const phone = String(body.phone || body.waId || body.wa_id || '').trim();
    if (!phone) return json(400, { success: false, code: 'PHONE_REQUIRED', message: 'Debe indicar el número de WhatsApp del propietario.' });
    try {
      const context = await buildContext({ phone });
      return json(200, context);
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      const safeStatus = [400, 404, 409].includes(statusCode) ? statusCode : 503;
      return json(safeStatus, {
        success: false,
        readOnly: true,
        code: error.code || 'VLA_AI_CONTEXT_UNAVAILABLE',
        message: safeStatus === 503 ? 'No se pudo consultar VLA en este momento.' : safeDisplayText(error.message, 240)
      });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = withAirtableUsage('vla-ai-context', createHandler());
