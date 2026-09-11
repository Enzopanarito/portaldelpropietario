'use strict';

const store = require('./_communications_store');
const { publicNotice } = require('./_communications_contract');

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '' };
  try {
    store.connect(event);
    const notice = publicNotice(await store.readNotice());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-VLA-Notice-Storage': 'strong-read-ok' }, body: JSON.stringify({ notice }) };
  } catch (error) {
    const diagnostic = String(error.code || error.name || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0,80);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-VLA-Notice-Storage': 'unavailable', 'X-VLA-Notice-Storage-Error': diagnostic }, body: JSON.stringify({ notice: null }) };
  }
};
