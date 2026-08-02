import crypto from 'node:crypto';
import client from './_mkj_client.js';

const {
  mkjLogin,
  listOrganizationUsers,
  listOrganizationDetailUsers,
  organizationUserId,
  organizationUserEmail,
  mkjSetMemberStatus,
  orgId
} = client;

// Huella SHA-256 de un secreto aleatorio temporal. El secreto nunca se publica.
// Se elimina junto con esta función al finalizar la recuperación de Casa 13.
const DIAGNOSTIC_SECRET_SHA256 = '61ce808972099b6b6e4dadfd94d74dc8f918f46b639f64d551721b684174877b';

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
    recordId: records[0].id,
    memberId: clean(fields['MKJ User ID'], 80),
    email: normalizedEmail(fields['MKJ Email'] || fields.Email)
  };
}

async function airtablePatchOwner(recordId, fields) {
  const token = clean(Netlify.env.get('AIRTABLE_API_TOKEN'), 512);
  const baseId = clean(Netlify.env.get('AIRTABLE_BASE_ID'), 80);
  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent('Propietarios')}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'No se pudo reconciliar la Casa 13 en Airtable.');
  return data;
}

function nowCaracas() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

function membershipActive(user) {
  if (typeof user?.membership_is_active === 'boolean') return user.membership_is_active;
  if (typeof user?.membership?.active === 'boolean') return user.membership.active;
  if (typeof user?.active === 'boolean') return user.active;
  return null;
}

function organizationId(user) {
  return clean(user?.organization_id ?? user?.membership?.organization_id, 80);
}

function authorized(req) {
  // Secreto exclusivo por contexto de despliegue; nunca se expone al navegador.
  const expected = clean(Netlify.env.get('MKJ_DIAGNOSTIC_SECRET'), 256);
  const provided = clean((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), 256);
  if (!provided) return false;
  const providedHash = crypto.createHash('sha256').update(provided).digest('hex');
  const hashMatches = crypto.timingSafeEqual(
    Buffer.from(DIAGNOSTIC_SECRET_SHA256),
    Buffer.from(providedHash)
  );
  if (!expected) return hashMatches;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  const envMatches = left.length === right.length && crypto.timingSafeEqual(left, right);
  return envMatches || hashMatches;
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
    email: organizationUserEmail(user),
    firstName: clean(user?.user?.first_name ?? user?.first_name, 80),
    lastName: clean(user?.user?.last_name ?? user?.last_name, 80),
    emailMatches: Boolean(wantedEmail && organizationUserEmail(user) === wantedEmail),
    idMatches: Boolean(memberId && organizationUserId(user) === memberId),
    userActive: typeof user?.is_active === 'boolean'
      ? user.is_active
      : typeof user?.user?.is_active === 'boolean'
        ? user.user.is_active
        : null,
    membershipActive: typeof user?.membership_is_active === 'boolean'
      ? user.membership_is_active
      : typeof user?.membership?.active === 'boolean'
        ? user.membership.active
        : typeof user?.active === 'boolean'
          ? user.active
          : null,
    organizationId: clean(user?.organization_id ?? user?.membership?.organization_id, 80),
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
    const { recordId, memberId, email } = await ownerForHouse(house);
    if (!memberId || !email) throw new Error(`La Casa ${house} no tiene ID y correo MKJ completos.`);
    const session = await mkjLogin();
    const [usersLookup, detailLookup] = await Promise.allSettled([
      listOrganizationUsers({ session }),
      listOrganizationDetailUsers({ session })
    ]);
    const usersResult = usersLookup.status === 'fulfilled' ? usersLookup.value : null;
    const detailResult = detailLookup.status === 'fulfilled' ? detailLookup.value : null;
    const usersMatches = exactMatches(usersResult?.users, memberId, email);
    const detailMatches = exactMatches(detailResult?.users, memberId, email);
    const exactMember = [...(usersResult?.users || []), ...(detailResult?.users || [])]
      .find(user => organizationUserId(user) === memberId);
    let repair = null;
    if (body.repair === true) {
      const expectedProviderEmail = normalizedEmail(body.expectedProviderEmail);
      const providerEmail = organizationUserEmail(exactMember);
      if (house !== 13 || memberId !== '8006') {
        throw new Error('La recuperación está limitada exclusivamente a la Casa 13 / usuario 8006.');
      }
      if (!exactMember || organizationId(exactMember) !== orgId()) {
        throw new Error('No se verificó el usuario 8006 dentro de la organización 1053.');
      }
      if (!expectedProviderEmail || providerEmail !== expectedProviderEmail) {
        throw new Error('El correo confirmado no coincide con la identidad devuelta por MKJ.');
      }
      const mkjResult = await mkjSetMemberStatus(memberId, 'enable', {
        email: providerEmail,
        session
      });
      await airtablePatchOwner(recordId, {
        'MKJ Email': providerEmail,
        'Estado Acceso Portón': 'Habilitado',
        'Última Sync MKJ': nowCaracas(),
        'Motivo Limitación Acceso': 'Membresía MKJ 8006 verificada activa y correo reconciliado.'
      });
      repair = {
        applied: true,
        memberId,
        providerEmail,
        membershipActiveBefore: membershipActive(exactMember),
        mkjStatus: mkjResult.status,
        mkjAlreadyApplied: mkjResult.idempotent === true,
        state: 'Habilitado'
      };
    }
    const lookupError = settled => settled.status === 'rejected'
      ? {
          code: settled.reason?.code || 'MKJ_LOOKUP_FAILED',
          status: settled.reason?.status || 500,
          message: settled.reason?.message || 'Consulta MKJ fallida.'
        }
      : null;
    return json(200, {
      success: true,
      house,
      memberId,
      organizationUsers: usersResult
        ? { status: usersResult.status, count: usersResult.users.length, matches: usersMatches, shape: responseShape(usersResult.data) }
        : { error: lookupError(usersLookup) },
      organizationDetail: detailResult
        ? { status: detailResult.status, count: detailResult.users.length, matches: detailMatches, shape: responseShape(detailResult.data) }
        : { error: lookupError(detailLookup) },
      membershipFound: usersMatches.length > 0 || detailMatches.length > 0,
      lookupComplete: Boolean(usersResult && detailResult),
      repair
    });
  } catch (error) {
    return json(502, { success: false, code: error.code || 'MKJ_DIAGNOSTIC_FAILED', message: error.message });
  }
}

export const config = {
  path: '/api/vla/internal/mkj-diagnostic'
};
