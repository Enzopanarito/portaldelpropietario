'use strict';

const store = require('./_shared/_communications_store');
const { publicNotice } = require('./_shared/_communications_contract');

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  try {
    store.connect(event);
    const notice = publicNotice(await store.readNotice());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify({ notice }) };
  } catch (_) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ notice: null }) };
  }
};
