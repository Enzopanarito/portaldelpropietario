import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mkjLogin,
  listOrganizationUsers,
  listOrganizationDetailUsers,
  organizationUserId,
  organizationUserEmail
} = require('./_mkj_client.js');

function clean(value, max = 254) {
  return String(value || '').trim().slice(0, max);
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

async function ownerForHouse(house) {
  const token = clean(Netlify.env.get('AIRTABLE_API_TOKEN'), 512);
  const baseId = clean(Netlify.env.get('AIRTABLE_BASE_ID'), 80);
  if (!token || !baseId) throw new Error('Airtable no está configurado para el diagnóstico.');
  const params = new URLSearchParams({
    maxRecords: '2',
    filterByFormula: `{Casa}=${house}`
  });
  for (const field of ['Casa', 'MKJ User ID', 'MKJ Email', 'Email']) params.append('fields[]', field);
  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('Propietarios')}?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'No se pudo leer la Casa solicitada.');
  const records = data.records || [];
  if (records.length !== 1) throw new Error(`Se esperó una sola Casa ${house} y se encontraron ${records.length}.`);
  const fields = records[0].fields || {};
  return {
    memberId: clean(fields['MKJ User ID'], 80),
    email: normalizedEmail(fields['MKJ Email'] || fields.Email)
  };
}

function authorized(req) {
  const expected = clean(Netlify.env.get('MKJ_DIAGNOSTIC_SECRET'), 256);
  const provided = clean((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), 256);
  if (!expected || !provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function exactMatches(users, memberId, email) {
  const wantedEmail = normalizedEmail(email);
  return (users || []).filter(user => {
    const idMatch = memberId && organizationUserId(user) === memberId;
    const emailMatch = wantedEmail && organizationUserEmail(user) === wantedEmail;
    return idMatch || emailMatch;
  }).map(user => ({
    userId: organizationUserId(user),
    emailMatches: Boolean(wantedEmail && organizationUserEmail(user) === wantedEmail),
    idMatches: Boolean(memberId && organizationUserId(user) === memberId),
    active: typeof user?.active === 'boolean'
      ? user.active
      : typeof user?.membership?.active === 'boolean'
        ? user.membership.active
        : null,
    keys: Object.keys(user || {}).sort().slice(0, 20)
  }));
}

function responseShape(value, depth = 0, seen = new Set()) {
  if (depth > 5 || value === null || value === undefined) return typeof value;
  if (typeof value !== 'object') return typeof value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? responseShape(value[0], depth + 1, seen) : null };
  const shape = {};
  for (const key of Object.keys(value).sort().slice(0, 30)) shape[key] = responseShape(value[key], depth + 1, seen);
  return shape;
}

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { success: false, message: 'Method Not Allowed' });
  if (!authorized(req)) return json(401, { success: false, message: 'No autorizado.' });

  let body = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const house = Number(body.house);
  if (!Number.isInteger(house) || house < 1 || house > 15) return json(400, { success: false, message: 'Casa inválida.' });

  try {
    const { memberId, email } = await ownerForHouse(house);
    if (!memberId || !email) throw new Error(`La Casa ${house} no tiene ID y correo MKJ completos.`);
    const session = await mkjLogin();
    const [usersResult, detailResult] = await Promise.all([
      listOrganizationUsers({ session }),
      listOrganizationDetailUsers({ session })
    ]);
    const usersMatches = exactMatches(usersResult.users, memberId, email);
    const detailMatches = exactMatches(detailResult.users, memberId, email);
    return json(200, {
      success: true,
      house,
      memberId,
      organizationUsers: { status: usersResult.status, count: usersResult.users.length, matches: usersMatches, shape: responseShape(usersResult.data) },
      organizationDetail: { status: detailResult.status, count: detailResult.users.length, matches: detailMatches, shape: responseShape(detailResult.data) },
      membershipFound: usersMatches.length > 0 || detailMatches.length > 0
    });
  } catch (error) {
    return json(502, { success: false, code: error.code || 'MKJ_DIAGNOSTIC_FAILED', message: error.message });
  }
}

export const config = {
  path: '/api/vla/internal/mkj-diagnostic'
};
