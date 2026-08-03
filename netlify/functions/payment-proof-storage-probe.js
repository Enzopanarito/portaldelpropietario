'use strict';

const crypto = require('crypto');
const { createProofStore, STORE_NAME } = require('./_payment_proof_store_compat');

const PROBE_TOKEN = 'E3PV8TwOndstfutuJDbk-8Y983R3EFpQ';

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== 'GET') return json(405, { ok: false });
  if (event.queryStringParameters?.token !== PROBE_TOKEN) return json(404, { ok: false });

  const content = Buffer.from(`VLA proof storage probe ${Date.now()}`, 'utf8');
  const attachmentSha = crypto.createHash('sha256').update(content).digest('hex');
  const reportId = `storage-probe-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  let storedKey = '';

  try {
    const proofStore = createProofStore();
    const saved = await proofStore.put({
      reportId,
      content,
      contentType: 'application/octet-stream',
      attachmentSha,
      variant: 'original'
    });
    storedKey = saved.key;

    const loaded = await proofStore.getByKey({
      key: storedKey,
      attachmentSha,
      contentType: 'application/octet-stream',
      variant: 'original'
    });
    if (!loaded || !Buffer.from(loaded.content).equals(content)) {
      throw Object.assign(new Error('La lectura posterior no coincidió con el contenido cifrado.'), { code: 'PROOF_PROBE_READ_MISMATCH' });
    }

    const { getStore } = await import('@netlify/blobs');
    await getStore(STORE_NAME, { consistency: 'strong' }).delete(storedKey);
    storedKey = '';

    return json(200, {
      ok: true,
      encryptedWrite: true,
      decryptedRead: true,
      cleanup: true,
      keySource: proofStore.keyring?.[0]?.source || 'configured-fallback'
    });
  } catch (error) {
    if (storedKey) {
      try {
        const { getStore } = await import('@netlify/blobs');
        await getStore(STORE_NAME, { consistency: 'strong' }).delete(storedKey);
      } catch (_) {}
    }
    return json(500, {
      ok: false,
      code: String(error?.code || 'PROOF_STORAGE_PROBE_FAILED'),
      detail: String(error?.message || error).slice(0, 500)
    });
  }
};
