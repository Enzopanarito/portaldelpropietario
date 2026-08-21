'use strict';

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }
  });
}
function safeError(error) { return String(error?.message || error || 'PLANT_UNKNOWN_ERROR').slice(0, 300); }

module.exports = { json, safeError };
