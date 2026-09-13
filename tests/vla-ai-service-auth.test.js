'use strict';

const assert = require('assert');
const { requireVlaAiService, strongSecret } = require('../netlify/functions/_shared/_vla_ai_service_auth');

const secret = 'x'.repeat(64);
assert.strictEqual(strongSecret('short'), false);
assert.strictEqual(strongSecret(secret), true);

let result = requireVlaAiService({ headers: {} }, {});
assert.strictEqual(result.ok, false);
assert.strictEqual(result.response.statusCode, 503);

result = requireVlaAiService({ headers: { authorization: 'Bearer wrong' } }, { VLA_AI_SERVICE_SECRET: secret });
assert.strictEqual(result.ok, false);
assert.strictEqual(result.response.statusCode, 401);

result = requireVlaAiService({ headers: { Authorization: `Bearer ${secret}` } }, { VLA_AI_SERVICE_SECRET: secret });
assert.strictEqual(result.ok, true);
assert.strictEqual(result.mode, 'READ_ONLY');

console.log('VLA_AI_SERVICE_AUTH_TESTS_OK');
