'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../netlify/functions/_mkj_client');

process.env.MKJ_BASE_URL = 'https://mkj.test';
process.env.MKJ_ORG_ID = '1053';
process.env.MKJ_ADMIN_EMAIL = 'admin@test.local';
process.env.MKJ_ADMIN_PASSWORD = 'secret-for-test';

function response(status, data, cookie = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === 'set-cookie' ? cookie : null },
    text: async () => data === null ? '' : JSON.stringify(data)
  };
}

test('MKJ usa autenticación híbrida Bearer y cookie para habilitar', async () => {
  client.clearSessionCache();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) return response(200, { access_token: 'jwt-current' }, 'access_token=cookie-current; Path=/; HttpOnly');
    return response(200, { success: true });
  };

  const result = await client.mkjSetMemberStatus('7795', 'enable', { fetchImpl });
  const statusCall = calls.find(call => call.url.endsWith('/members/7795/enable'));
  assert.equal(result.authMode, 'bearer+cookie');
  assert.equal(statusCall.options.method, 'PUT');
  assert.equal(statusCall.options.headers.Authorization, 'Bearer jwt-current');
  assert.equal(statusCall.options.headers.Cookie, 'access_token=cookie-current');
});

test('un 404 por ID desactualizado se recupera por correo dentro de la organización', async () => {
  client.clearSessionCache();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) return response(200, { access_token: 'jwt-current' }, 'access_token=cookie-current; Path=/');
    if (url.endsWith('/members/old-id/enable')) return response(404, { error: 'Member not found' });
    if (url.endsWith('/organizations/1053/users')) return response(200, { users: [{ id: 9001, email: 'owner@test.local' }] });
    if (url.endsWith('/members/9001/enable')) return response(200, { success: true });
    return response(500, { error: 'unexpected route' });
  };

  const result = await client.mkjSetMemberStatus('old-id', 'enable', { email: 'OWNER@test.local', fetchImpl });
  assert.equal(result.resolvedMemberId, '9001');
  assert.equal(result.recoveredMemberId, true);
  assert(calls.some(call => call.url.endsWith('/organizations/1053/users')));
  assert(calls.some(call => call.url.endsWith('/members/9001/enable')));
});

test('MKJ nunca usa el endpoint global de usuario como atajo inseguro', async () => {
  client.clearSessionCache();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/login')) return response(200, { access_token: 'jwt-current' }, 'access_token=cookie-current; Path=/');
    if (url.endsWith('/members/missing/disable')) return response(404, { error: 'Member not found' });
    if (url.endsWith('/organizations/1053/users')) return response(200, { users: [] });
    return response(500, { error: 'unexpected route' });
  };

  await assert.rejects(
    client.mkjSetMemberStatus('missing', 'disable', { email: 'missing@test.local', fetchImpl }),
    error => error.code === 'MKJ_MEMBER_NOT_FOUND' && error.status === 404
  );
  assert.equal(calls.some(call => /\/api\/users\/[^/]+\/status/.test(call.url)), false);
});
