'use strict';

const crypto = require('node:crypto');

const VERSION = 1;
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

function keyMaterial(env = process.env) {
  const key = String(env.PAYMENT_DATE_ATTESTATION_SECRET || env.PAYMENT_PROOF_ENCRYPTION_KEY || env.ADMIN_TOKEN_SECRET || '').trim();
  return key ? crypto.createHash('sha256').update(`VLA_PAYMENT_DATE_ATTESTATION\0${key}`).digest() : null;
}

function attachmentSha(content) {
  if (!Buffer.isBuffer(content) || !content.length) return '';
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizedClaims({ ownerId, method, transactionDate, transactionDateSource, attachmentContent, issuedAt }) {
  return {
    v: VERSION,
    ownerId: String(ownerId || '').trim(),
    method: String(method || '').trim().toUpperCase(),
    transactionDate: String(transactionDate || '').trim(),
    transactionDateSource: String(transactionDateSource || '').trim().toUpperCase(),
    attachmentSha: attachmentSha(attachmentContent),
    issuedAt: Number(issuedAt || Date.now())
  };
}

function createDateAttestation(input, options = {}) {
  const key = keyMaterial(options.env);
  if (!key) return '';
  const claims = normalizedClaims({ ...input, issuedAt: options.now instanceof Date ? options.now.getTime() : options.now || Date.now() });
  if (!claims.ownerId || !claims.method || !claims.transactionDate || !claims.attachmentSha) return '';
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyDateAttestation(token, expected, options = {}) {
  try {
    const key = keyMaterial(options.env);
    const [payload, signature, extra] = String(token || '').split('.');
    if (!key || !payload || !signature || extra) return false;
    const calculated = crypto.createHmac('sha256', key).update(payload).digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(calculated);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const wanted = normalizedClaims({ ...expected, issuedAt: claims.issuedAt });
    const now = options.now instanceof Date ? options.now.getTime() : Number(options.now || Date.now());
    if (claims.v !== VERSION || !Number.isFinite(claims.issuedAt) || claims.issuedAt > now + 60_000 || now - claims.issuedAt > MAX_AGE_MS) return false;
    return ['ownerId', 'method', 'transactionDate', 'transactionDateSource', 'attachmentSha'].every(field => claims[field] === wanted[field]);
  } catch (_) {
    return false;
  }
}

module.exports = { VERSION, MAX_AGE_MS, keyMaterial, attachmentSha, normalizedClaims, createDateAttestation, verifyDateAttestation };
