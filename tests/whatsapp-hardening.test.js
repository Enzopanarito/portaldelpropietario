'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'netlify/functions/whatsapp-jobs.js'), 'utf8');
const agent = fs.readFileSync(path.join(root, 'local-whatsapp-agent/whatsapp_agent.py'), 'utf8');
const page = fs.readFileSync(path.join(root, 'whatsapp.html'), 'utf8');

assert(source.includes("begin('WHATSAPP_JOB_CLAIM'"));
assert(source.includes("begin('WHATSAPP_SCHEDULE'"));
assert(source.includes("resource==='scheduler-run'"));
assert(source.includes("body.action==='heartbeat'"));
assert(agent.includes('heartbeat'));
assert(agent.includes('claimJob'));
assert(agent.includes('error.status!=401'));
assert(page.includes('Cada 2 días'));
assert(page.includes("action:'runScheduler'"));

const authPath = require.resolve('../netlify/functions/_auth');
const guardPath = require.resolve('../netlify/functions/_operation_guard');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { requireAdminCurrent: async () => ({ ok: true }) }
};
require.cache[guardPath] = {
  id: guardPath,
  filename: guardPath,
  loaded: true,
  exports: {
    begin: async () => ({ ok: true, marker: { id: 'recGUARD00000001' } }),
    setState: async () => ({})
  }
};
delete require.cache[require.resolve('../netlify/functions/whatsapp-jobs')];
const mod = require('../netlify/functions/whatsapp-jobs');
const schedule = mod.normalizeSchedule({
  id: 'recSCHED00000001',
  fields: {
    Nombre: 'Recordatorio cada 2 días 09:10',
    'Día del Mes': 0,
    Hora: '09:10',
    Activo: true
  }
});
assert.strictEqual(schedule.frequency, 'Cada 2 días');
const now = new Date('2026-07-12T13:10:00.000Z');
assert.strictEqual(mod.isScheduleDue({ ...schedule, lastRun: '2026-07-10T13:00:00.000Z' }, now), true);
assert.strictEqual(mod.isScheduleDue({ ...schedule, lastRun: '2026-07-11T13:00:00.000Z' }, now), false);
console.log('WHATSAPP_HARDENING_OK');
