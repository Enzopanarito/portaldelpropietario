'use strict';

// Cliente único para MKJ Cloud. El frontend oficial de MKJ usa autenticación
// híbrida (Bearer + cookie); mantener ambas evita respuestas 404/401 ambiguas.

const SESSION_TTL_MS = 2 * 60 * 1000;
const VALID_ACTIONS = new Set(['enable', 'disable']);

let cachedSession = null;
let cachedSessionExpiresAt = 0;

function baseUrl() {
  return (process.env.MKJ_BASE_URL || 'https://cloud.mkjoules.com').replace(/\/$/, '');
}

function orgId() {
  return String(process.env.MKJ_ORG_ID || '1053').trim();
}

function extractCookie(setCookieHeaders) {
  const raw = Array.isArray(setCookieHeaders) ? setCookieHeaders.join(',') : String(setCookieHeaders || '');
  const match = raw.match(/access_token=[^;]+/);
  return match ? match[0] : '';
}

async function readResponse(response) {
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text || null; }
  return { text, data };
}

function providerMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data.replace(/\s+/g, ' ').trim().slice(0, 240);
  return String(data.error || data.message || data.detail || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function mkjError(message, status, data, code = 'MKJ_REQUEST_FAILED') {
  const detail = providerMessage(data);
  const error = new Error(`${message}: HTTP ${status}${detail ? ` - ${detail}` : ''}`);
  error.code = code;
  error.status = status;
  error.providerDetail = detail;
  return error;
}

function authHeaders(session, extra = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  return headers;
}

async function mkjLogin(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: process.env.MKJ_ADMIN_EMAIL, password: process.env.MKJ_ADMIN_PASSWORD })
  });
  const { data } = await readResponse(response);
  const cookie = extractCookie(response.headers.get('set-cookie'));
  const token = String(data?.access_token || '').trim();
  if (!response.ok || (!cookie && !token)) throw mkjError('Login MKJ falló', response.status, data, 'MKJ_LOGIN_FAILED');
  return { cookie, token, status: response.status, authenticatedAt: Date.now() };
}

async function getSession(options = {}) {
  if (options.session) return await options.session;
  if (options.fetchImpl || options.forceRefresh === true) return mkjLogin(options);
  if (cachedSession && Date.now() < cachedSessionExpiresAt) return cachedSession;
  cachedSession = await mkjLogin(options);
  cachedSessionExpiresAt = Date.now() + SESSION_TTL_MS;
  return cachedSession;
}

function clearSessionCache() {
  cachedSession = null;
  cachedSessionExpiresAt = 0;
}

async function request(path, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const session = await getSession(options);
  const init = {
    method: options.method || 'GET',
    headers: authHeaders(session, options.headers || {})
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetchImpl(`${baseUrl()}${path}`, init);
  const parsed = await readResponse(response);
  return { response, ...parsed, session };
}

function organizationUsers(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['users', 'members', 'items', 'data']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function organizationUserId(user) {
  return String(
    user?.id ??
    user?.user_id ??
    user?.user?.id ??
    user?.membership?.user_id ??
    ''
  ).trim();
}

function organizationUserEmail(user) {
  return normalizedEmail(
    user?.email ??
    user?.user_email ??
    user?.user?.email ??
    user?.membership?.email ??
    ''
  );
}

function resolveOrganizationUser(users, memberId, email) {
  const requestedId = String(memberId || '').trim();
  const requestedEmail = normalizedEmail(email);
  const byEmail = requestedEmail
    ? users.find(user => organizationUserEmail(user) === requestedEmail)
    : null;
  if (byEmail) return byEmail;

  const byId = users.find(user => organizationUserId(user) === requestedId) || null;
  if (!byId) return null;

  // Si contamos con correo, no aceptamos silenciosamente un ID que pertenezca
  // a otra persona. Solo usamos el ID cuando MKJ no devuelve correo o coincide.
  const byIdEmail = organizationUserEmail(byId);
  if (requestedEmail && byIdEmail && byIdEmail !== requestedEmail) return null;
  return byId;
}

function providerAlreadyInDesiredState(action, data) {
  const detail = providerMessage(data).toLowerCase();
  if (action === 'enable') return /already\s+(?:active|enabled)/.test(detail);
  return /already\s+(?:inactive|disabled)/.test(detail);
}

async function listOrganizationUsers(options = {}) {
  const result = await request(`/api/organizations/${encodeURIComponent(orgId())}/users`, options);
  if (!result.response.ok) throw mkjError('MKJ no pudo listar los usuarios de la organización', result.response.status, result.data, 'MKJ_USERS_LOOKUP_FAILED');
  return { users: organizationUsers(result.data), session: result.session, status: result.response.status };
}

async function setStatusRequest(memberId, action, options = {}) {
  const path = `/api/organizations/${encodeURIComponent(orgId())}/members/${encodeURIComponent(memberId)}/${action}`;
  return request(path, {
    ...options,
    method: 'PUT',
    headers: { Referer: `${baseUrl()}/admin/dashboard`, ...(options.headers || {}) }
  });
}

async function mkjSetMemberStatus(memberId, action, options = {}) {
  const requestedMemberId = String(memberId || '').trim();
  if (!requestedMemberId) throw Object.assign(new Error('Falta MKJ User ID.'), { code: 'MKJ_MEMBER_ID_REQUIRED' });
  if (!VALID_ACTIONS.has(action)) throw Object.assign(new Error('Acción MKJ inválida.'), { code: 'MKJ_ACTION_INVALID' });

  let result = await setStatusRequest(requestedMemberId, action, options);

  // Una sesión vieja puede ser rechazada de forma opaca. Renovamos una sola vez.
  if (result.response.status === 401 || result.response.status === 403) {
    clearSessionCache();
    const refreshed = await getSession({ ...options, session: null, forceRefresh: true });
    result = await setStatusRequest(requestedMemberId, action, { ...options, session: refreshed });
  }

  let resolvedMemberId = requestedMemberId;
  let recoveredMemberId = false;
  let verifiedMembership = false;
  let idempotent = false;
  let providerStatus = result.response.status;

  // MKJ usa 404 tanto para una membresía inexistente como para una operación
  // ya aplicada ("not found or already active/inactive"). Verificamos primero
  // que el usuario pertenece a esta organización. Solo entonces aceptamos el
  // resultado como éxito idempotente o reintentamos con el ID vigente.
  if (result.response.status === 404) {
    let lookup = null;
    try {
      lookup = await listOrganizationUsers({ ...options, session: result.session });
    } catch (_) {
      lookup = null;
    }

    const matched = lookup
      ? resolveOrganizationUser(lookup.users, requestedMemberId, options.email)
      : null;
    const candidateId = organizationUserId(matched);
    verifiedMembership = Boolean(candidateId);

    if (candidateId && candidateId !== requestedMemberId) {
      resolvedMemberId = candidateId;
      recoveredMemberId = true;
      result = await setStatusRequest(resolvedMemberId, action, { ...options, session: lookup.session });
      providerStatus = result.response.status;
    }

    if (
      verifiedMembership &&
      result.response.status === 404 &&
      providerAlreadyInDesiredState(action, result.data)
    ) {
      idempotent = true;
    }
  }

  if (!result.response.ok && !idempotent) {
    const code = result.response.status === 404 ? 'MKJ_MEMBER_NOT_FOUND' : 'MKJ_STATUS_UPDATE_FAILED';
    throw mkjError(`MKJ ${action} falló`, result.response.status, result.data, code);
  }

  return {
    status: idempotent ? 200 : result.response.status,
    providerStatus,
    data: result.data,
    requestedMemberId,
    resolvedMemberId,
    recoveredMemberId,
    verifiedMembership,
    idempotent,
    authMode: result.session?.token && result.session?.cookie ? 'bearer+cookie' : result.session?.token ? 'bearer' : 'cookie'
  };
}

module.exports = {
  baseUrl,
  orgId,
  extractCookie,
  mkjLogin,
  mkjSetMemberStatus,
  listOrganizationUsers,
  resolveOrganizationUser,
  providerAlreadyInDesiredState,
  clearSessionCache
};
