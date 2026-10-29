'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const lifecycle = require('../netlify/functions/_shared/_expense_lifecycle');

const src = fs.readFileSync(path.join(__dirname, '..', 'admin-recurring-expenses.js'), 'utf8');
const getLine = name => {
  const found = src.split('\n').find(line => line.trim().startsWith(`function ${name}(`));
  assert.ok(found, `No se encontró ${name}`);
  return found;
};
const helpers = ['monthLabel', 'nextMonth', 'titleMonth'].map(getLine).join('\n');

function renderUnderTimezone(tz, months) {
  const js = `const vm=require('node:vm');const m=vm.runInNewContext(${JSON.stringify(helpers + '\n({monthLabel,nextMonth,titleMonth})')}); console.log(JSON.stringify(${JSON.stringify(months)}.map(month=>({month,display:m.titleMonth(month),next:m.nextMonth(month),nextLabel:m.titleMonth(m.nextMonth(month))}))));`;
  const result = spawnSync(process.execPath, ['-e', js], { encoding: 'utf8', env: {...process.env, TZ: tz} });
  assert.equal(result.status, 0, result.stderr || `Error con zona ${tz}`);
  return JSON.parse(result.stdout.trim());
}

test('precarga octubre de 2026 muestra noviembre, nunca octubre por el huso horario del navegador', () => {
  for (const zone of ['America/Caracas', 'America/New_York', 'America/Los_Angeles', 'UTC', 'Europe/Rome', 'Asia/Tokyo']) {
    const [oct] = renderUnderTimezone(zone, ['2026-10']);
    assert.equal(oct.display, 'Octubre de 2026', `Mes actual incorrecto en ${zone}`);
    assert.equal(oct.next, '2026-11', `Mes de destino incorrecto en ${zone}`);
    assert.equal(oct.nextLabel, 'Noviembre de 2026', `Etiqueta de precarga incorrecta en ${zone}`);
  }
});

test('enero y cambio de año se etiquetan correctamente en cualquier zona', () => {
  for (const zone of ['America/Caracas', 'America/New_York', 'UTC', 'Asia/Tokyo']) {
    const [dec, jan] = renderUnderTimezone(zone, ['2026-12', '2027-01']);
    assert.equal(dec.display, 'Diciembre de 2026');
    assert.equal(dec.next, '2027-01');
    assert.equal(dec.nextLabel, 'Enero de 2027');
    assert.equal(jan.display, 'Enero de 2027');
    assert.equal(jan.nextLabel, 'Febrero de 2027');
  }
});

test('los cálculos del servidor y el formulario mantienen el mes YYYY-MM del gasto sin desplazamiento', () => {
  assert.equal(lifecycle.currentMonthCaracas(new Date('2026-10-29T21:45:00.000Z')), '2026-10');
  assert.equal(lifecycle.nextMonth('2026-10'), '2026-11');
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const plant = fs.readFileSync(path.join(__dirname, '..', 'admin-plant-v1.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/admin-expense.js'), 'utf8');
  assert.match(html, /monthChoice==='next'\?monthDate\.toISOString\(\)\.slice\(0,7\):currentMonth/);
  assert.match(plant, /monthChoice === 'next' \? monthDate\.toISOString\(\)\.slice\(0, 7\) : currentMonth/);
  assert.match(server, /allowedMonths=new Set\(\[currentMonth,nextMonth\(currentMonth\)\]\)/);
  assert.match(src, /timeZone:'UTC'/);
  const parity = fs.readFileSync(path.join(__dirname, '..', 'admin-feature-parity.js'), 'utf8');
  assert.match(parity, /admin-recurring-expenses\.js\?v=20261029-month-label-utc/);
});
