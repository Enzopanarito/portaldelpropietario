'use strict';

const { requireAdmin } = require('./_shared/_auth');
const { deepEscapeStrings, safeDisplayText } = require('./_shared/_security_utils');
const contract = require('./_shared/_communications_contract');
const store = require('./_shared/_communications_store');
const { improveCommunication } = require('./_shared/_communications_ai');
const { loadCatalog, publicCatalog } = require('./_shared/_communications_catalog');
const { relayCommunication } = require('./_shared/_communications_relay');

function json(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(body) }; }
function safeJob(job) {
  if (!job) return null;
  return deepEscapeStrings({
    jobId: job.jobId, subject: job.subject, channels: job.channels, status: job.status,
    recipientCount: Array.isArray(job.ownerIds) ? job.ownerIds.length : Number(job.recipientCount || 0),
    linkedExpenseId: job.linkedExpenseId || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
    startedAt: job.startedAt || null, completedAt: job.completedAt || null,
    email: job.email || null, whatsapp: job.whatsapp || null, error: job.error || null
  });
}
async function status(jobId) {
  const job = await store.readJob(jobId);
  if (!job) return { job: null };
  let whatsappRuntime = null;
  if ((job.channels || []).includes('whatsapp')) {
    try {
      const raw = await relayCommunication('broadcast-status', { jobId });
      whatsappRuntime = raw?.communication || null;
    } catch (error) {
      whatsappRuntime = { jobId, status: 'UNAVAILABLE', error: safeDisplayText(error.message, 220) };
    }
  }
  return { job: safeJob(job), whatsappRuntime: deepEscapeStrings(whatsappRuntime) };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  try {
    store.connect(event);
    const params = event.queryStringParameters || {};
    if (event.httpMethod === 'GET') {
      const action = String(params.action || 'catalog');
      if (action === 'catalog') {
        const [catalog, notice, recent] = await Promise.all([loadCatalog(), store.readNotice(), store.recentJobs(8)]);
        return json(200, { ...publicCatalog(catalog), notice: contract.publicNotice(notice), recent: recent.map(safeJob) });
      }
      if (action === 'status') return json(200, await status(String(params.jobId || '')));
      return json(400, { message: 'Acción no reconocida.' });
    }
    if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
    const body = JSON.parse(event.body || '{}');
    const action = String(body.action || '').toLowerCase();
    if (action === 'improve') {
      const improved = await improveCommunication({ subject: body.subject, body: body.body, purpose: body.purpose === 'banner' ? 'banner' : 'message' });
      return json(200, deepEscapeStrings({ success: true, subject: improved.subject, body: improved.body, model: improved.model }));
    }
    if (action === 'publish-notice') {
      if (body.confirm !== 'PUBLICAR') return json(400, { message: 'La publicación requiere confirmación explícita.' });
      const notice = contract.normalizeNotice({ subject: body.subject, body: body.body, level: body.level });
      await store.writeNotice(notice);
      return json(200, { success: true, notice: contract.publicNotice(notice), message: 'Aviso publicado durante 24 horas.' });
    }
    if (action === 'remove-notice') {
      await store.writeNotice({ version: 1, active: false, removedAt: new Date().toISOString() });
      return json(200, { success: true, notice: null, message: 'Aviso retirado.' });
    }
    if (action === 'create-job') {
      if (body.confirm !== 'ENVIAR') return json(400, { message: 'El envío requiere confirmación explícita.' });
      const draft = contract.normalizeDraft(body);
      const channels = contract.normalizeChannels(body.channels);
      const ownerIds = contract.normalizeOwnerIds(body.ownerIds);
      const catalog = await loadCatalog();
      const valid = new Set(catalog.owners.map(owner => owner.id));
      if (ownerIds.some(id => !valid.has(id))) return json(400, { message: 'La selección contiene una casa que ya no existe.' });
      const linkedExpenseId = String(body.linkedExpenseId || '').trim();
      if (linkedExpenseId && !catalog.expenses.some(expense => expense.id === linkedExpenseId)) return json(400, { message: 'El gasto vinculado ya no está activo.' });
      const now = new Date();
      const jobId = contract.jobIdFromRequest(body.operationId, now);
      const job = await store.createJob({
        version: 1, jobId, operationId: String(body.operationId), subject: draft.subject, body: draft.body,
        channels, ownerIds, linkedExpenseId: linkedExpenseId || null, status: 'QUEUED',
        createdAt: now.toISOString(), updatedAt: now.toISOString(), recipientCount: ownerIds.length,
        email: channels.includes('email') ? { status: 'QUEUED', sent: 0, failed: 0, skipped: 0 } : null,
        whatsapp: channels.includes('whatsapp') ? { status: 'QUEUED', accepted: false } : null
      });
      return json(200, { success: true, job: safeJob(job), dispatchPath: '/.netlify/functions/communications-dispatch-background' });
    }
    return json(400, { message: 'Acción no reconocida.' });
  } catch (error) {
    const code = String(error.code || 'COMMUNICATIONS_ERROR');
    const statusCode = code.startsWith('AI_') || code === 'TIMEOUT' ? 502 : 500;
    return json(statusCode, { message: safeDisplayText(error.message || 'No fue posible completar la comunicación.', 400), code });
  }
};

exports._test = { safeJob };
