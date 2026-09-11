'use strict';

const { requireAdmin } = require('./_auth');
const { sendMail } = require('./_mailer');
const { safeDisplayText } = require('./_security_utils');
const contract = require('./_communications_contract');
const store = require('./_communications_store');
const { loadCatalog } = require('./_communications_catalog');
const { relayCommunication } = require('./_communications_relay');

function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }; }

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return response(405, { message: 'Method Not Allowed' });
  let jobId = '';
  let claimed = false;
  try {
    store.connect(event);
    const body = JSON.parse(event.body || '{}');
    jobId = String(body.jobId || '').trim();
    if (!await store.readJob(jobId)) return response(404, { message: 'El comunicado no existe.' });
    const claim = await store.claimJob(jobId);
    if (!claim.claimed) return response(200, { success: true, idempotent: true, jobId, status: claim.job?.status });
    claimed = true;
    const job = claim.job;
    const catalog = await loadCatalog();
    const ownerSet = new Set(job.ownerIds || []);
    const owners = catalog.owners.filter(owner => ownerSet.has(owner.id));
    if (owners.length !== ownerSet.size) throw new Error('Cambió el catálogo de propietarios; el envío fue bloqueado antes de despachar.');
    const expense = job.linkedExpenseId ? catalog.expenses.find(item => item.id === job.linkedExpenseId) : null;
    if (job.linkedExpenseId && !expense) throw new Error('El gasto vinculado ya no está activo; el envío fue bloqueado.');
    const messages = owners.map(owner => ({ owner, message: contract.personalizedMessage({ jobId, subject: job.subject, body: job.body, owner, expense }) }));

    let email = job.email;
    if ((job.channels || []).includes('email')) {
      const results = await Promise.all(messages.map(async item => {
        if (!item.owner.Email) return { house: item.owner.Casa, status: 'SKIPPED' };
        try {
          const result = await sendMail({
            to: item.owner.Email,
            subject: `${job.subject} · Casa ${item.owner.Casa}`,
            html: contract.emailDocument({ subject: job.subject, message: item.message, house: item.owner.Casa })
          });
          return { house: item.owner.Casa, status: result.sent ? 'SENT' : 'FAILED', detail: result.status };
        } catch (error) { return { house: item.owner.Casa, status: 'FAILED', detail: safeDisplayText(error.message, 180) }; }
      }));
      email = {
        status: results.every(item => item.status === 'SENT') ? 'DONE' : results.some(item => item.status === 'SENT') ? 'PARTIAL' : 'FAILED',
        sent: results.filter(item => item.status === 'SENT').length,
        failed: results.filter(item => item.status === 'FAILED').length,
        skipped: results.filter(item => item.status === 'SKIPPED').length,
        results
      };
      await store.updateJob(jobId, { email });
    }

    let whatsapp = job.whatsapp;
    if ((job.channels || []).includes('whatsapp')) {
      const data = await relayCommunication('broadcast', {
        jobId,
        recipients: messages.map(item => ({ house: item.owner.Casa, message: item.message }))
      });
      whatsapp = { status: 'ACCEPTED', accepted: data?.queued?.accepted === true || data?.queued?.idempotent === true, idempotent: data?.queued?.idempotent === true, acceptedAt: new Date().toISOString() };
      if (!whatsapp.accepted) throw new Error('La Mac mini no confirmó la cola del comunicado.');
    }
    const hasWhatsapp = (job.channels || []).includes('whatsapp');
    const completedAt = hasWhatsapp ? null : new Date().toISOString();
    const final = await store.updateJob(jobId, { status: hasWhatsapp ? 'DELIVERY_STARTED' : email?.status === 'DONE' ? 'DONE' : 'PARTIAL', email, whatsapp, completedAt });
    return response(200, { success: true, jobId, status: final.status });
  } catch (error) {
    if (claimed) await store.updateJob(jobId, current => ({
      status: current?.email?.sent > 0 ? 'PARTIAL' : 'FAILED_SAFE',
      error: safeDisplayText(error.message, 300), completedAt: new Date().toISOString()
    })).catch(() => null);
    return response(500, { message: 'El comunicado fue detenido de forma segura.', detail: safeDisplayText(error.message, 300) });
  }
};
