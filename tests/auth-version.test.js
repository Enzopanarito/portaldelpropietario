'use strict';

const assert = require('assert');
const path = require('path');

const storePath = require.resolve('../netlify/functions/_admin_auth_store');
const authPath = require.resolve('../netlify/functions/_auth');
let currentVersion = 7;
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: { loadConfigRecord: async () => ({ record:null, config:{ version:currentVersion } }) }
};
delete require.cache[authPath];

process.env.ADMIN_TOKEN_SECRET = 'independent-token-secret-for-tests';
process.env.ADMIN_PASSWORD = 'Admin-Password-Should-Not-Sign-Tokens!';
const auth = require('../netlify/functions/_auth');

(async () => {
  const token = auth.issueAdminToken({ authVersion:7 });
  const event = { headers:{ authorization:`Bearer ${token}` } };
  const accepted = await auth.requireAdminCurrent(event);
  assert.strictEqual(accepted.ok, true);
  assert.strictEqual(accepted.authVersion, 7);

  currentVersion = 8;
  const revoked = await auth.requireAdminCurrent(event, { force:true });
  assert.strictEqual(revoked.ok, false);
  assert.strictEqual(revoked.response.statusCode, 401);
  assert(JSON.parse(revoked.response.body).message.includes('revocada'));

  delete process.env.ADMIN_TOKEN_SECRET;
  assert.throws(() => auth.issueAdminToken({ authVersion:8 }), /ADMIN_TOKEN_SECRET/);
  console.log('AUTH_VERSION_REVOCATION_OK');
})().catch(error => { console.error(error); process.exit(1); });
