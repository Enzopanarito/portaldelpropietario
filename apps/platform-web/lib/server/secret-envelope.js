import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 1;

function decodeMasterKey(base64Key) {
  const raw = Buffer.from(String(base64Key || ''), 'base64');
  if (raw.length !== 32) {
    throw Object.assign(new Error('Master key must decode to 32 bytes'), { code: 'MASTER_KEY_INVALID' });
  }
  return raw;
}

function buildAad({ tenantId = 'platform', purpose, keyVersion }) {
  if (!purpose || !keyVersion) {
    throw Object.assign(new Error('Secret purpose and key version are required'), { code: 'SECRET_CONTEXT_INVALID' });
  }
  return Buffer.from(`rcp:v${VERSION}:${tenantId}:${purpose}:${keyVersion}`, 'utf8');
}

export function sealSecret({ plaintext, tenantId, purpose, keyVersion, masterKeyBase64 }) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw Object.assign(new Error('Secret plaintext is required'), { code: 'SECRET_VALUE_REQUIRED' });
  }

  const key = decodeMasterKey(masterKeyBase64);
  const iv = crypto.randomBytes(12);
  const aad = buildAad({ tenantId, purpose, keyVersion });
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Object.freeze({
    envelopeVersion: VERSION,
    algorithm: 'AES-256-GCM',
    keyVersion,
    ivB64: iv.toString('base64'),
    authTagB64: tag.toString('base64'),
    ciphertextB64: ciphertext.toString('base64'),
    aadHash: crypto.createHash('sha256').update(aad).digest('hex')
  });
}

export function openSecret({ envelope, tenantId, purpose, masterKeyBase64 }) {
  if (!envelope || envelope.envelopeVersion !== VERSION || envelope.algorithm !== 'AES-256-GCM') {
    throw Object.assign(new Error('Unsupported secret envelope'), { code: 'SECRET_ENVELOPE_UNSUPPORTED' });
  }

  if (!/^[0-9a-f]{64}$/.test(String(envelope.aadHash || ''))) {
    throw Object.assign(new Error('Invalid secret envelope hash'), { code: 'SECRET_ENVELOPE_INVALID' });
  }
  const iv = Buffer.from(String(envelope.ivB64 || ''), 'base64');
  const authTag = Buffer.from(String(envelope.authTagB64 || ''), 'base64');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw Object.assign(new Error('Invalid secret envelope parameters'), { code: 'SECRET_ENVELOPE_INVALID' });
  }

  const key = decodeMasterKey(masterKeyBase64);
  const aad = buildAad({ tenantId, purpose, keyVersion: envelope.keyVersion });
  const expectedHash = crypto.createHash('sha256').update(aad).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(envelope.aadHash, 'hex'))) {
    throw Object.assign(new Error('Secret context mismatch'), { code: 'SECRET_CONTEXT_MISMATCH' });
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertextB64, 'base64')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    throw Object.assign(new Error('Secret authentication failed'), { code: 'SECRET_AUTH_FAILED', cause: error });
  }
}

export function generateMasterKeyBase64() {
  return crypto.randomBytes(32).toString('base64');
}
