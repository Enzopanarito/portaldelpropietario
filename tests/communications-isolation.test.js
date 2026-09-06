'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('../netlify/functions/_shared/_communications_contract');
const broadcast = require('../ops/whatsapp-runtime/agent/lib/broadcast');

const ROOT = path.join(__dirname, '..');
const source = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = rel => crypto.createHash('sha256').update(source(rel)).digest('hex');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

test('respaldo contractual: el flujo completo de reporte de pago permanece byte a byte intacto', () => {
  const expected = {
    'netlify/functions/public-report-payment.js': '27e6c68f1b4b8f6e01ce876e724ece0d2e0b9f3aff220e0e20079755460b7f3e',
    'owner-payment-report-v3.js': '22c8ed9d0ff3e989c0f10668095db77c1c16267122e8e0fa5386ecf2c755b590',
    'owner-payment-report-v3.css': '884d7838b97f68f55978875f69a36db1de8baa883ef49f343b465035eaf87b2a',
    'payment-report-intelligence.js': '247911c5df02ce2cc8a9fe5cb0eab459cfc9ad04c02e1e9d88e0337168eb906c',
    'netlify/functions/process-payment-report.js': '5369463f99d65f4b236e23a6a85a472a39e08a68a534de473dc02f13afddd16e',
    'netlify/functions/_shared/_payment_proof_core.js': 'a998d07837c9f80a161a615771554eab55df09a2d034b0c41bba4e3564aab41b'
  };
  for (const [file, digest] of Object.entries(expected)) assert.equal(sha256(file), digest, file);
});

test('automatización financiera de WhatsApp y su plantilla permanecen byte a byte intactas', () => {
  assert.equal(sha256('netlify/functions/whatsapp-jobs.js'), 'ccbb196a365c0f23e897e48ab612f966a92d69294f02f4f05120c5add94e1cfc');
  assert.equal(sha256('ops/whatsapp-runtime/agent/lib/message.js'), '021ecea597b23ecacace73baedb08d1171f4b318fae721dce486cb2762867f38');
  const controller = source('ops/whatsapp-control/controller.js');
  assert.equal((controller.match(/setInterval\(\(\) => state\.schedulerStep\(\)/g) || []).length, 1);
  assert.match(controller, /AUTOMATIC_RUN_OPTIONS = Object\.freeze\(\{ forcePlan: false \}\)/);
  assert.match(controller, /const RETRY_MS = 5 \* 60 \* 1000/);
});

test('banner es accesorio: un fallo nunca entra al try financiero ni bloquea reportes', () => {
  const owner = source('index.html');
  assert.match(owner, /function loadPublicNotice\(\).*catch\(_\).*aviso nunca bloquea saldos ni reportes de pago/s);
  assert.match(owner, /async function init\(\)\{loadPublicNotice\(\);try\{/);
  for (const marker of ['reportForm', 'public-report-payment', 'reportBtn', 'reportSide', 'reportMobile', 'submitReport']) assert.match(owner, new RegExp(marker));
});

test('comunicaciones no tiene permiso de escritura financiera ni acceso a credenciales del cliente', () => {
  const files = ['netlify/functions/admin-communications.js', 'netlify/functions/communications-dispatch-background.js', 'netlify/edge-functions/admin-communications.js'];
  const joined = files.map(source).join('\n');
  assert.doesNotMatch(joined, /monthly-close|admin-expense-action|admin-manual-payment|process-payment-report|access-mode|mkj-access/i);
  assert.doesNotMatch(source('netlify/edge-functions/admin-communications.js'), /AIRTABLE_API_TOKEN|SMTP_SECRET|GEMINI_API_KEY|WA_AGENT_TOKEN|VLA_WHATSAPP_CONTROL_SECRET/);
  assert.match(source('netlify/functions/admin-communications.js'), /requireAdmin\(event\)/);
  assert.match(source('netlify/functions/communications-dispatch-background.js'), /requireAdmin\(event\)/);
});

test('aviso dura exactamente 24 horas y expira del contrato público', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  const notice = contract.normalizeNotice({ subject: 'Aviso importante', body: 'Contenido verificable del aviso.', level: 'important' }, now);
  assert.equal(Date.parse(notice.expiresAt) - Date.parse(notice.publishedAt), 24 * 60 * 60 * 1000);
  assert.ok(contract.publicNotice(notice, new Date('2026-09-07T11:59:59.999Z')));
  assert.equal(contract.publicNotice(notice, new Date('2026-09-07T12:00:00.000Z')), null);
});

test('100 lotes personalizados conservan casas, referencias y montos sin duplicados', () => {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const jobId = `COM-20260906-${iteration.toString(16).toUpperCase().padStart(12, '0')}`;
    const ownerIds = Array.from({ length: 15 }, (_, i) => `rec${String(i + 1).padStart(14, 'A')}`);
    const expense = { fields: { Monto: 1500 + iteration, 'Tipo de Gasto': 'Gasto Especial', Propietarios: ownerIds } };
    const recipients = ownerIds.map((id, i) => {
      const owner = { id, Casa: i + 1, Propietario: `Propietario ${i + 1}`, Alicuota: 1 / 15 };
      return { house: i + 1, message: contract.personalizedMessage({ jobId, subject: 'Compra de gasoil', body: 'Se registró la compra informada.', owner, expense }) };
    });
    const normalized = broadcast.normalizeBroadcastPayload({ jobId, recipients }, hash);
    assert.equal(normalized.recipients.length, 15);
    assert.equal(new Set(normalized.recipients.map(item => item.house)).size, 15);
    normalized.recipients.forEach(item => assert.match(item.message, new RegExp(`VLA-${jobId}-C${String(item.house).padStart(2, '0')}`)));
  }
});

test('una referencia o casa duplicada bloquea el lote antes de abrir WhatsApp', () => {
  const jobId = 'COM-20260906-ABCDEF123456';
  const good = `Mensaje suficientemente largo.\n\nReferencia informativa: VLA-${jobId}-C01`;
  assert.throws(() => broadcast.normalizeBroadcastPayload({ jobId, recipients: [{ house: 1, message: good }, { house: 1, message: good }] }, hash), /duplicada/i);
  assert.throws(() => broadcast.normalizeBroadcastPayload({ jobId, recipients: [{ house: 1, message: 'Mensaje suficientemente largo sin referencia.' }] }, hash), /Referencia/i);
});

test('una casa sin teléfono nunca se contabiliza como entrega completada', () => {
  assert.deepEqual(broadcast.summarizeBroadcast({ recipients: { 1: { status: 'NO_PHONE' } } }), {
    status: 'FAILED_SAFE', confirmedCount: 0, quarantinedCount: 0, failedSafeCount: 1
  });
  assert.equal(broadcast.summarizeBroadcast({ recipients: {
    1: { status: 'SENT_CONFIRMED', confirmedAt: '2026-09-06T00:00:00Z' },
    2: { status: 'NO_PHONE' }
  } }).status, 'PARTIAL_FAILED_SAFE');
});

test('IA solo redacta: la interfaz exige una segunda acción y confirmación para enviar', () => {
  const ui = source('netlify/edge-functions/admin-communications.js');
  const backend = source('netlify/functions/admin-communications.js');
  assert.match(ui, /Mejorar con IA/);
  assert.match(ui, /Revisar y enviar/);
  assert.match(ui, /confirm\('Se enviará este comunicado/);
  assert.match(backend, /body\.confirm !== 'ENVIAR'/);
  assert.match(backend, /body\.confirm !== 'PUBLICAR'/);
});

test('instalador local crea respaldo verificable, restaura en error y nunca dispara WhatsApp', () => {
  const relative = 'ops/whatsapp-control/INSTALAR_COMUNICACIONES_SEGURAS.command';
  const installer = source(relative);
  const checked = spawnSync('bash', ['-n', path.join(ROOT, relative)], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  for (const marker of [
    'communications-preinstall-', 'SHA256SUMS.txt', 'RESTAURAR_COMUNICACIONES.command',
    'agent-state.json', 'CONTROL_BEFORE_SHA', 'rollback_on_error',
    'state.json cambió', 'control.json cambió'
  ]) assert.match(installer, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(installer, /OLD_AGENT_SHA="a4705ff/);
  assert.match(installer, /OLD_CONTROLLER_SHA="215ece/);
  assert.match(installer, /NEW_AGENT_SHA="1b43b265/);
  assert.match(installer, /NEW_CONTROLLER_SHA="66ff4bf2/);
  assert.doesNotMatch(installer, /curl[^\n]*(?:\/tick|\/warmup|\/session\/link)/i);
  assert.doesNotMatch(installer, /docker\s+compose[^\n]+\bdown\b/i);
  assert.doesNotMatch(installer, /(?:cp|mv|rm)[^\n]*(?:\.env|credentials?\.json|whatsapp-agent-data\/profile)/i);
});
