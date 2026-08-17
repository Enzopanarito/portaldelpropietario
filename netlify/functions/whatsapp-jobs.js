const { withAirtableUsage } = require('./_shared/_airtable_meter');
// netlify/functions/whatsapp-jobs.js
// Módulo histórico de órdenes de WhatsApp.
// Desde la arquitectura Controller/Agent, este endpoint es SOLO LECTURA por defecto.
// El Controller local es el único scheduler autorizado.

const { requireAdmin } = require('./_shared/_auth');

const JOBS_TABLE = 'WhatsApp Jobs';
const SCHEDULES_TABLE = 'WhatsApp Programaciones';
const LEGACY_MUTATIONS_ENABLED = String(process.env.VLA_ENABLE_LEGACY_WHATSAPP_JOBS || '').trim().toLowerCase() === 'true';

function headers() {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
}
function json(statusCode, body) {
  return { statusCode, headers: headers(), body: JSON.stringify(body) };
}
function legacyDisabled(reason = 'El módulo histórico de WhatsApp está en modo solo lectura.') {
  return json(410, {
    ok: false,
    code: 'LEGACY_WHATSAPP_JOBS_DISABLED',
    message: reason,
    schedulerAuthority: 'controller',
    legacyMutationsEnabled: false
  });
}
function airtableUrl(tableName, query = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${query}`;
}
async function airtable(tableName, options = {}, query = '') {
  if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no está configurado.');
  const response = await fetch(airtableUrl(tableName, query), {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error Airtable ${tableName}`);
  return data;
}
async function listAll(tableName, query = '') {
  let records = [];
  let offset = null;
  do {
    const sep = query ? '&' : '?';
    const data = await airtable(tableName, {}, `${query}${offset ? `${sep}offset=${encodeURIComponent(offset)}` : ''}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}
function caracasParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function nowIso() { return new Date().toISOString(); }
function jobId(prefix = 'WA') {
  const p = caracasParts();
  return `${prefix}-${p.year}${p.month}${p.day}-${p.hour}${p.minute}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}
function normalizeJob(record) {
  const f = record.fields || {};
  return {
    recordId: record.id,
    jobId: f['Job ID'] || '',
    type: f.Tipo || '',
    mode: f.Modo || '',
    status: f.Estado || '',
    scheduledAt: f['Fecha Programada'] || '',
    createdAt: f['Creado En'] || '',
    startedAt: f['Ejecutado En'] || '',
    finishedAt: f['Finalizado En'] || '',
    sent: Number(f.Enviados || 0),
    simulated: Number(f.Simulados || 0),
    errors: Number(f.Errores || 0),
    avoidDuplicates: !!f['Evitar Duplicados'],
    force: !!f['Forzar Envío'],
    requestedBy: f['Solicitado Por'] || '',
    executedBy: f['Ejecutado Por'] || '',
    log: f.Log || ''
  };
}
function normalizeSchedule(record) {
  const f = record.fields || {};
  const day = Number(f['Día del Mes'] || 0);
  return {
    recordId: record.id,
    name: f.Nombre || '',
    day,
    frequency: day === 0 ? 'Diario' : 'Mensual',
    hour: f.Hora || '',
    mode: f.Modo || 'Simulación',
    active: !!f.Activo,
    lastRun: f['Última Ejecución'] || '',
    lastJobId: f['Último Job ID'] || '',
    notes: f.Notas || ''
  };
}
async function createJob(input = {}) {
  const id = jobId(input.source === 'scheduler' ? 'WA-AUTO' : 'WA');
  const fields = {
    'Job ID': id,
    'Tipo': input.type || 'Recordatorio morosos',
    'Modo': input.mode || 'Simulación',
    'Estado': 'Pendiente',
    'Fecha Programada': input.scheduledAt || nowIso(),
    'Creado En': nowIso(),
    'Enviados': 0,
    'Simulados': 0,
    'Errores': 0,
    'Evitar Duplicados': input.avoidDuplicates !== false,
    'Forzar Envío': !!input.force,
    'Solicitado Por': input.requestedBy || 'Admin',
    'Payload': JSON.stringify({ source: input.source || 'admin', scheduleId: input.scheduleId || null, frequency: input.frequency || null }, null, 2),
    'Log': `Orden creada ${new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`
  };
  const data = await airtable(JOBS_TABLE, { method: 'POST', body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return normalizeJob(data.records[0]);
}
async function listJobs() {
  const query = `?maxRecords=40&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Creado En')}&sort%5B0%5D%5Bdirection%5D=desc`;
  return (await listAll(JOBS_TABLE, query)).map(normalizeJob);
}
async function listSchedules() {
  const query = `?sort%5B0%5D%5Bfield%5D=${encodeURIComponent('Día del Mes')}&sort%5B0%5D%5Bdirection%5D=asc`;
  return (await listAll(SCHEDULES_TABLE, query)).map(normalizeSchedule);
}
async function dueJobs() {
  const formula = encodeURIComponent(`AND({Estado}='Pendiente', IS_BEFORE({Fecha Programada}, DATEADD(NOW(), 1, 'minutes')))`);
  return (await listAll(JOBS_TABLE, `?filterByFormula=${formula}`)).map(normalizeJob);
}
async function updateJobByJobId(id, fields) {
  const formula = encodeURIComponent(`{Job ID}='${String(id).replace(/'/g, "\\'")}'`);
  const records = await listAll(JOBS_TABLE, `?filterByFormula=${formula}&maxRecords=1`);
  if (!records[0]) throw new Error('Orden no encontrada.');
  const data = await airtable(JOBS_TABLE, { method: 'PATCH', body: JSON.stringify({ records: [{ id: records[0].id, fields }], typecast: true }) });
  return normalizeJob(data.records[0]);
}

// Conservadas únicamente como ruta de contingencia explícita para jobs históricos.
// NUNCA deben crear o ejecutar programación automática: esa autoridad pertenece al Controller.
async function createSchedule() {
  throw new Error('LEGACY_SCHEDULER_DISABLED');
}
async function runScheduler() {
  throw new Error('LEGACY_SCHEDULER_DISABLED');
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  try {
    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.rawQuery || '');
      const resource = params.get('resource') || 'jobs';
      if (resource === 'schedules') return json(200, {
        schedules: await listSchedules(), legacy: true, readOnly: true, schedulerAuthority: 'controller'
      });
      if (resource === 'due-jobs') return json(200, {
        jobs: await dueJobs(), legacy: true, readOnly: true, schedulerAuthority: 'controller'
      });
      if (resource === 'scheduler-run') {
        return legacyDisabled('El scheduler histórico está retirado. El Controller local es el único planificador autorizado.');
      }
      return json(200, {
        jobs: await listJobs(), legacy: true, readOnly: true, schedulerAuthority: 'controller'
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

    const body = JSON.parse(event.body || '{}');
    const action = body.action || 'createJob';

    // Las mutaciones que podrían reintroducir un segundo scheduler permanecen
    // deshabilitadas incluso si se habilita la contingencia legacy.
    if (action === 'createSchedule' || action === 'runScheduler') {
      return legacyDisabled('La programación histórica está retirada de forma permanente. Use el Controller WhatsApp.');
    }

    // Escape hatch explícito para administrar jobs históricos durante una contingencia.
    // Por defecto está apagado y no debe habilitarse en operación normal.
    if (!LEGACY_MUTATIONS_ENABLED) {
      return legacyDisabled('Las mutaciones del módulo histórico están deshabilitadas. El Control WhatsApp canónico vive en Controller/Agent.');
    }

    if (action === 'createJob') return json(200, { job: await createJob(body), legacy: true });
    if (action === 'cancelJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: 'Cancelado', Log: `Cancelado desde admin ${nowIso()}` }), legacy: true });
    if (action === 'claimJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: 'Ejecutando', 'Ejecutado En': nowIso(), 'Ejecutado Por': body.executedBy || 'Mac local' }), legacy: true });
    if (action === 'finishJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: body.status === 'Error' ? 'Error' : 'Completado', 'Finalizado En': nowIso(), Enviados: Number(body.sent || 0), Simulados: Number(body.simulated || 0), Errores: Number(body.errors || 0), Log: body.log || '' }), legacy: true });
    return json(400, { message: 'Acción no reconocida.' });
  } catch (error) {
    if (error.message === 'LEGACY_SCHEDULER_DISABLED') {
      return legacyDisabled('El scheduler histórico está retirado. El Controller local es el único planificador autorizado.');
    }
    return json(500, { message: 'Error en módulo WhatsApp.', detail: error.message });
  }
};

exports.handler = withAirtableUsage('whatsapp-jobs', handler);
exports._test = {
  LEGACY_MUTATIONS_ENABLED,
  createSchedule,
  runScheduler
};