// netlify/functions/mkj-access.js
// Integración MKJoules: login automático + enable/disable de usuarios por ID.
// Las credenciales se leen únicamente desde variables privadas de Netlify.

const { requireAdminCurrent } = require('./_auth');

const TABLE_PROPIETARIOS = 'Propietarios';
const ALLOWED_ACTIONS = new Set(['enable', 'disable', 'test-login', 'save-identifiers']);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function baseUrl() {
  return (process.env.MKJ_BASE_URL || 'https://cloud.mkjoules.com').replace(/\/$/, '');
}

function orgId() {
  return process.env.MKJ_ORG_ID || '1053';
}

function requiredEnv() {
  const missing = [];
  if (!process.env.MKJ_ADMIN_EMAIL) missing.push('MKJ_ADMIN_EMAIL');
  if (!process.env.MKJ_ADMIN_PASSWORD) missing.push('MKJ_ADMIN_PASSWORD');
  if (!process.env.AIRTABLE_API_TOKEN) missing.push('AIRTABLE_API_TOKEN');
  if (!process.env.AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  return missing;
}

function extractCookie(setCookieHeaders) {
  const raw = Array.isArray(setCookieHeaders) ? setCookieHeaders.join(',') : String(setCookieHeaders || '');
  const match = raw.match(/access_token=[^;]+/);
  return match ? match[0] : '';
}

async function mkjLogin() {
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: process.env.MKJ_ADMIN_EMAIL, password: process.env.MKJ_ADMIN_PASSWORD })
  });

  const text = await response.text();
  const cookie = extractCookie(response.headers.get('set-cookie'));
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (!response.ok || !cookie) {
    throw new Error(`Login MKJ falló: HTTP ${response.status}${data?.message ? ' - ' + data.message : ''}`);
  }

  return { cookie, status: response.status };
}

async function mkjSetMemberStatus(memberId, action) {
  const login = await mkjLogin();
  const url = `${baseUrl()}/api/organizations/${encodeURIComponent(orgId())}/members/${encodeURIComponent(memberId)}/${action}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Cookie': login.cookie,
      'Referer': `${baseUrl()}/admin/users/${encodeURIComponent(memberId)}`
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text || null; }

  if (!response.ok) {
    throw new Error(`MKJ ${action} falló: HTTP ${response.status}${data?.message ? ' - ' + data.message : ''}`);
  }
  return { status: response.status, data };
}

function airtableUrl(path = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_PROPIETARIOS)}${path}`;
}

async function airtableGetOwner(ownerId) {
  const response = await fetch(airtableUrl('/' + encodeURIComponent(ownerId)), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'No se pudo leer propietario en Airtable.');
  return data;
}

async function airtablePatchOwner(ownerId, fields) {
  const response = await fetch(airtableUrl('/' + encodeURIComponent(ownerId)), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'No se pudo actualizar propietario en Airtable.');
  return data;
}

function nowCaracas() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}

exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  const action = String(body.action || '').trim();
  if (!ALLOWED_ACTIONS.has(action)) return json(400, { success: false, message: 'Acción inválida.' });

  const required = action === 'save-identifiers'
    ? ['AIRTABLE_API_TOKEN','AIRTABLE_BASE_ID'].filter(name => !process.env[name])
    : requiredEnv();
  if (required.length) return json(500, { success:false, message:'Faltan variables privadas en Netlify.', missing:required });

  try {
    if (action === 'save-identifiers') {
      const ownerId = String(body.ownerId || '').trim();
      const mkjUserId = String(body.mkjUserId || '').trim();
      const mkjEmail = String(body.mkjEmail || '').trim().toLowerCase();
      if (!/^rec[A-Za-z0-9]{14}$/.test(ownerId)) return json(400, { success:false, message:'Propietario inválido.' });
      if (mkjUserId && !/^[A-Za-z0-9_-]{1,100}$/.test(mkjUserId)) return json(400, { success:false, message:'MKJ User ID inválido.' });
      if (mkjEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mkjEmail) || mkjEmail.length > 254)) return json(400, { success:false, message:'Correo MKJ inválido.' });
      const updated = await airtablePatchOwner(ownerId, { 'MKJ User ID':mkjUserId, 'MKJ Email':mkjEmail });
      return json(200, { success:true, message:'Identificadores MKJ guardados mediante flujo protegido.', owner:{ id:updated.id, fields:updated.fields } });
    }

    if (action === 'test-login') {
      const login = await mkjLogin();
      return json(200, { success: true, action, message: 'Login MKJoules exitoso.', mkjStatus: login.status });
    }

    const ownerId = body.ownerId;
    const rawMemberId = String(body.mkjUserId || '').trim();
    if (!ownerId && !rawMemberId) return json(400, { success: false, message: 'Debe indicar propietario o MKJ User ID.' });

    let owner = null;
    let memberId = rawMemberId;
    if (ownerId) {
      owner = await airtableGetOwner(ownerId);
      memberId = memberId || String(owner.fields?.['MKJ User ID'] || '').trim();
    }
    if (!memberId) return json(400, { success: false, message: 'Este propietario no tiene MKJ User ID configurado.' });

    const result = await mkjSetMemberStatus(memberId, action);
    const estado = action === 'enable' ? 'Habilitado' : 'Limitado';
    const motivo = body.reason || (action === 'enable' ? 'Habilitación manual desde portal.' : 'Limitación manual desde portal.');

    let updatedOwner = null;
    if (ownerId) {
      updatedOwner = await airtablePatchOwner(ownerId, {
        'Estado Acceso Portón': estado,
        'Última Sync MKJ': nowCaracas(),
        'Motivo Limitación Acceso': motivo
      });
    }

    return json(200, {
      success: true,
      action,
      mkjUserId: memberId,
      estado,
      mkjStatus: result.status,
      message: action === 'enable' ? 'Acceso habilitado en MKJoules.' : 'Acceso limitado en MKJoules.',
      owner: updatedOwner ? { id: updatedOwner.id, fields: updatedOwner.fields } : null
    });
  } catch (error) {
    return json(500, { success: false, message: 'Error sincronizando con MKJoules.', detail: error.message });
  }
};