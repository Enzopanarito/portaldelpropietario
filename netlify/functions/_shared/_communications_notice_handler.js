'use strict';

const store = require('./_communications_store');
const { publicNotice } = require('./_communications_contract');

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  try {
    store.connect(event);
    const notice = publicNotice(await store.readNotice());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-VLA-Notice-Storage': 'strong-read-ok' }, body: JSON.stringify({ notice }) };
  } catch (_) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-VLA-Notice-Storage': 'unavailable' }, body: JSON.stringify({ notice: null }) };
  }
};
