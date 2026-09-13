'use strict';

const assert = require('assert');
const { createHandler } = require('../netlify/functions/vla-ai-context');

(async () => {
  let builds = 0;
  const handler = createHandler({
    requireVlaAiService: () => ({ ok: true }),
    buildVlaAiContext: async ({ phone }) => { builds += 1; return { success: true, readOnly: true, identity: { phone } }; }
  });

  let response = await handler({ httpMethod: 'GET', headers: {} });
  assert.strictEqual(response.statusCode, 405);
  assert.strictEqual(builds, 0);

  response = await handler({ httpMethod: 'POST', headers: {}, body: '{broken' });
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(builds, 0);

  response = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.strictEqual(response.statusCode, 400);
  assert.strictEqual(builds, 0);

  response = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ wa_id: '584121234567' }) });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(JSON.parse(response.body).readOnly, true);
  assert.strictEqual(builds, 1);

  const blocked = createHandler({
    requireVlaAiService: () => ({ ok: false, response: { statusCode: 401, body: '{}' } }),
    buildVlaAiContext: async () => { throw new Error('should-not-run'); }
  });
  response = await blocked({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ phone: '584121234567' }) });
  assert.strictEqual(response.statusCode, 401);

  console.log('VLA_AI_ENDPOINT_TESTS_OK');
})().catch(error => { console.error(error); process.exit(1); });
