import fs from 'node:fs';
import crypto from 'node:crypto';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getKey() {
  const raw = String(process.env.VLA_BACKUP_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) fail('VLA_BACKUP_ENCRYPTION_KEY debe ser una clave hexadecimal de 32 bytes.');
  return Buffer.from(raw, 'hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function encrypt(inputPath, outputPath) {
  const plaintext = fs.readFileSync(inputPath);
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    format: 'vla-backup-envelope',
    version: 1,
    algorithm: 'AES-256-GCM',
    createdAt: new Date().toISOString(),
    plaintextSha256: sha256(plaintext),
    plaintextBytes: plaintext.length,
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
  fs.writeFileSync(outputPath, JSON.stringify(envelope));
  console.log(`VLA_BACKUP_ENCRYPTED sha256=${envelope.plaintextSha256} bytes=${plaintext.length}`);
}

function decrypt(inputPath, outputPath) {
  const envelope = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (envelope?.format !== 'vla-backup-envelope' || envelope?.version !== 1 || envelope?.algorithm !== 'AES-256-GCM') {
    fail('Formato de backup cifrado no soportado.');
  }
  const key = getKey();
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.authTag || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1) fail('Envelope cifrado inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const hash = sha256(plaintext);
  if (hash !== envelope.plaintextSha256) fail('Hash del backup restaurado no coincide.');
  if (plaintext.length !== Number(envelope.plaintextBytes)) fail('Tamaño del backup restaurado no coincide.');
  fs.writeFileSync(outputPath, plaintext);
  console.log(`VLA_BACKUP_DECRYPTED sha256=${hash} bytes=${plaintext.length}`);
}

const [mode, inputPath, outputPath] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(mode) || !inputPath || !outputPath) {
  fail('Uso: node scripts/vla-backup-crypto.mjs <encrypt|decrypt> <input> <output>');
}

if (mode === 'encrypt') encrypt(inputPath, outputPath);
else decrypt(inputPath, outputPath);
