'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { buildRestrictionMessage, expiredDebt } = require('../ops/whatsapp-runtime/agent/lib/message.js');
const { scheduleSummary } = require('../ops/whatsapp-runtime/agent/lib/schedule.js');

function parts() {
  return { year:'2026', month:'10', day:'01', hour:'08', minute:'00', second:'00' };
}

test('aviso de portón separa USD y Bs y suma solo total referencial', () => {
  const owner = {
    Casa: 1,
    Propietario: 'Fernando Berbeci',
    deudaVencidaUsd: 110,
    deudaVencidaBs: 67.5
  };
  const debt = expiredDebt(owner);
  assert.deepEqual(debt, { usd:110, bs:67.5, total:177.5 });
  const built = buildRestrictionMessage({ owner, nowParts:parts() });
  assert.match(built.text, /USD:\*? \$110,00, pagaderos en divisas/);
  assert.match(built.text, /Bs:\*? equivalente referencial a \$67,50, pagadero en bolívares a la tasa BCV del día/);
  assert.match(built.text, /TOTAL REFERENCIAL DEUDA VENCIDA: \$177,50/);
});

test('aviso omite la moneda que no tenga deuda vencida', () => {
  const onlyBs = buildRestrictionMessage({
    owner:{ Casa:12, Propietario:'Gabriel Rodriguez', deudaVencidaUsd:0, deudaVencidaBs:111.39 },
    nowParts:parts()
  }).text;
  assert.doesNotMatch(onlyBs, /USD:/);
  assert.match(onlyBs, /\$111,39/);

  const onlyUsd = buildRestrictionMessage({
    owner:{ Casa:15, Propietario:'Eduardo Capriles', deudaVencidaUsd:50, deudaVencidaBs:0 },
    nowParts:parts()
  }).text;
  assert.match(onlyUsd, /USD:/);
  assert.doesNotMatch(onlyUsd, /Bs:/);
});

test('día 1 conserva el recordatorio financiero normal a las 09:00', () => {
  const schedule = scheduleSummary(2026, 10);
  assert.equal(schedule[0].day, 1);
  assert.equal(schedule[0].time, '09:00');
  assert.equal(schedule[0].kind, 'month_start');
});

test('agent construye referencias exclusivas de las 08:00 y exige cierre certificado', () => {
  const source = fs.readFileSync(path.join(ROOT, 'ops/whatsapp-runtime/agent/server.js'), 'utf8');
  assert.match(source, /VLA-\$\{parts\.year\}\$\{parts\.month\}\$\{parts\.day\}0800-C/);
  assert.match(source, /previousCloseStatus !== 'DONE'/);
  assert.match(source, /Estado Acceso Portón/);
  assert.match(source, /accesoEsperado/);
  assert.match(source, /dispatchAttemptedAt/);
  assert.match(source, /ALREADY_QUARANTINED/);
});
