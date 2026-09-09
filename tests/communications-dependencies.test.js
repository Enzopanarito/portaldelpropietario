'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { computePerceptualHash } = require('../netlify/functions/_shared/_payment_visual_hash');
const { emailDocument } = require('../netlify/functions/_shared/_communications_contract');

test('Sharp actualizado conserva huellas de comprobantes PNG/JPEG/WebP con decodificación real', async () => {
  const width = 90, height = 80;
  const raw = Buffer.from(Array.from({ length: width * height }, (_, i) => Math.floor((i % width) * 255 / (width - 1))));
  let expected;
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']]) {
    const input = await sharp(raw, { raw: { width, height, channels: 1 } })[format]().toBuffer();
    const result = await computePerceptualHash(input, mime);
    assert.equal(result.supported, true);
    assert.equal(result.algorithm, 'dhash-64-v1');
    assert.match(result.hash, /^[a-f0-9]{16}$/i);
    expected ||= result.hash;
    assert.equal(result.hash, expected, format);
    assert.deepEqual(await computePerceptualHash(input, mime), result);
  }
  await assert.rejects(computePerceptualHash(Buffer.from('invalid'), 'image/png'), { code: 'VISUAL_HASH_FAILED' });
});

test('Nodemailer actualizado genera comunicado MIME personalizado sin conexión SMTP', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const html = emailDocument({ subject: 'Compra de gasoil', message: 'Estimado(a) Propietario de prueba:\n\nCompra registrada.', house: 1 });
  const result = await transport.sendMail({ from: 'admin@example.invalid', to: 'owner@example.invalid', subject: 'Compra de gasoil · Casa 1', html });
  assert.deepEqual(result.envelope.to, ['owner@example.invalid']);
  assert.ok(Buffer.isBuffer(result.message));
  assert.match(result.message.toString(), /Content-Type: text\/html/);
  assert.match(result.message.toString(), /Casa 1/);
});
