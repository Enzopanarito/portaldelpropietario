'use strict';

const { requireAdmin } = require('./_auth');
const { cleanPlainText } = require('./_security_utils');
const adminData = require('./admin-data-v3');
const { buildPreviewPayload } = require('./_messaging_core');

const HEADERS = {
  'Content-Type':'application/json',
  'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma:'no-cache',
  Expires:'0',
  'X-Content-Type-Options':'nosniff',
  'X-VLA-Messaging':'preview-v1'
};

function json(statusCode, body) {
  return { statusCode, headers:HEADERS, body:JSON.stringify(body) };
}

function parseHouse(event) {
  const value = event.queryStringParameters && event.queryStringParameters.house;
  if (value === undefined || value === null || value === '') return null;
  const house = Number(value);
  return Number.isInteger(house) && house >= 1 && house <= 15 ? house : NaN;
}

exports.handler = async function handler(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'GET') return json(405, { message:'Method Not Allowed' });

  const house = parseHouse(event);
  if (Number.isNaN(house)) return json(400, { message:'Casa inválida.' });

  try {
    const adminEvent = {
      ...event,
      queryStringParameters:{ ...(event.queryStringParameters || {}), force:'1' }
    };
    const response = await adminData.handler(adminEvent);
    if (response.statusCode !== 200) {
      const detail = JSON.parse(response.body || '{}');
      return json(response.statusCode || 503, {
        message:'No se pudo obtener una fotografía financiera oficial para mensajería.',
        detail:cleanPlainText(detail.detail || detail.message || 'Datos administrativos no disponibles.', 500)
      });
    }

    const adminPayload = JSON.parse(response.body || '{}');
    if (Number(adminPayload.balanceEngineVersion) !== 5 || adminPayload.officialBalanceSource !== 'ControlVersiones') {
      return json(503, {
        message:'Mensajería bloqueada: la fuente financiera oficial no está disponible.',
        balanceEngineVersion:adminPayload.balanceEngineVersion || null,
        officialBalanceSource:adminPayload.officialBalanceSource || null
      });
    }

    const preview = buildPreviewPayload(adminPayload, { generatedAt:new Date().toISOString() });
    if (preview.totalOwners !== 15) {
      return json(503, {
        message:'Mensajería bloqueada: la fotografía no contiene las 15 casas.',
        totalOwners:preview.totalOwners
      });
    }

    if (house !== null) preview.recipients = preview.recipients.filter(item => item.house === house);
    return json(200, preview);
  } catch (error) {
    return json(500, {
      message:'No se pudo generar la vista previa de mensajería.',
      detail:cleanPlainText(error && error.message, 500)
    });
  }
};
