const BODYLESS_METHODS = new Set(['GET', 'HEAD']);

function headersObject(headers) {
  return Object.fromEntries(Array.from(headers.entries()));
}

function queryObject(url) {
  const values = {};
  for (const [key, value] of url.searchParams.entries()) values[key] = value;
  return values;
}

export async function toLegacyEvent(request) {
  const url = new URL(request.url);
  return {
    httpMethod: request.method,
    headers: headersObject(request.headers),
    body: BODYLESS_METHODS.has(request.method) ? null : await request.text(),
    isBase64Encoded: false,
    path: url.pathname,
    rawPath: url.pathname,
    rawUrl: request.url,
    queryStringParameters: queryObject(url),
    __netlifyModernRuntime: true
  };
}

export function toWebResponse(result) {
  if (result instanceof Response) return result;
  if (!result) return new Response(null, { status: 204 });
  const headers = new Headers(result.headers || {});
  for (const [name, values] of Object.entries(result.multiValueHeaders || {})) {
    for (const value of values || []) headers.append(name, value);
  }
  const status = Number(result.statusCode || 200);
  const body = result.body == null
    ? null
    : result.isBase64Encoded
      ? Buffer.from(String(result.body), 'base64')
      : String(result.body);
  return new Response(body, { status, headers });
}

export async function invokeLegacy(request, context, legacyHandler) {
  const event = await toLegacyEvent(request);
  const result = await legacyHandler(event, context);
  return toWebResponse(result);
}
