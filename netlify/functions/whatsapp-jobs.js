// netlify/functions/whatsapp-jobs.js
// Módulo liviano e independiente para órdenes de WhatsApp. No afecta admin-data ni contabilidad.

const { requireAdmin } = require('./_auth');

const JOBS_TABLE = 'WhatsApp Jobs';
const SCHEDULES_TABLE = 'WhatsApp Programaciones';

function headers() {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
}
function json(statusCode, body) {
  return { statusCode, headers: headers(), body: JSON.stringify(body) };
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
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
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
async function createSchedule(input = {}) {
  const dayValue = Number(input.day ?? (input.frequency === 'Diario' ? 0 : 1));
  const isDaily = dayValue === 0 || input.frequency === 'Diario';
  const fields = {
    'Nombre': input.name || (isDaily ? `Recordatorio diario ${input.hour || '09:00'}` : `Recordatorio día ${dayValue || 1}`),
    'Día del Mes': isDaily ? 0 : (dayValue || 1),
    'Hora': input.hour || '09:00',
    'Modo': input.mode || 'Simulación',
    'Activo': input.active !== false,
    'Notas': input.notes || (isDaily ? 'Programación diaria automática. Día del Mes = 0 significa diario.' : '')
  };
  const data = await airtable(SCHEDULES_TABLE, { method: 'POST', body: JSON.stringify({ records: [{ fields }], typecast: true }) });
  return normalizeSchedule(data.records[0]);
}
async function runScheduler() {
  const p = caracasParts();
  const today = `${p.year}-${p.month}-${p.day}`;
  const currentDay = Number(p.day);
  const currentMinute = Number(p.hour) * 60 + Number(p.minute);
  const schedules = await listSchedules();
  const created = [];
  for (const s of schedules) {
    const isDaily = s.day === 0;
    if (!s.active || !/^\d{2}:\d{2}$/.test(s.hour)) continue;
    if (!isDaily && s.day !== currentDay) continue;
    const [hh, mm] = s.hour.split(':').map(Number);
    const target = hh * 60 + mm;
    if (currentMinute < target || currentMinute > target + 14) continue;
    if (s.lastRun && String(s.lastRun).slice(0, 10) === today) continue;
    const job = await createJob({ mode: s.mode || 'Simulación', requestedBy: isDaily ? 'Programación diaria automática' : 'Programación automática', source: 'scheduler', scheduleId: s.recordId, frequency: isDaily ? 'Diario' : 'Mensual' });
    await airtable(SCHEDULES_TABLE, { method: 'PATCH', body: JSON.stringify({ records: [{ id: s.recordId, fields: { 'Última Ejecución': nowIso(), 'Último Job ID': job.jobId } }], typecast: true }) });
    created.push(job);
  }
  return { checkedAt: nowIso(), createdCount: created.length, created };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  try {
    if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.rawQuery || '');
      const resource = params.get('resource') || 'jobs';
      if (resource === 'schedules') return json(200, { schedules: await listSchedules() });
      if (resource === 'due-jobs') return json(200, { jobs: await dueJobs() });
      if (resource === 'scheduler-run') return json(200, await runScheduler());
      return json(200, { jobs: await listJobs() });
    }
    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
    const body = JSON.parse(event.body || '{}');
    if (body.action === 'createJob' || !body.action) return json(200, { job: await createJob(body) });
    if (body.action === 'cancelJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: 'Cancelado', Log: `Cancelado desde admin ${nowIso()}` }) });
    if (body.action === 'claimJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: 'Ejecutando', 'Ejecutado En': nowIso(), 'Ejecutado Por': body.executedBy || 'Mac local' }) });
    if (body.action === 'finishJob') return json(200, { job: await updateJobByJobId(body.jobId, { Estado: body.status === 'Error' ? 'Error' : 'Completado', 'Finalizado En': nowIso(), Enviados: Number(body.sent || 0), Simulados: Number(body.simulated || 0), Errores: Number(body.errors || 0), Log: body.log || '' }) });
    if (body.action === 'createSchedule') return json(200, { schedule: await createSchedule(body) });
    if (body.action === 'runScheduler') return json(200, await runScheduler());
    return json(400, { message: 'Acción no reconocida.' });
  } catch (error) {
    return json(500, { message: 'Error en módulo WhatsApp.', detail: error.message });
  }
};
