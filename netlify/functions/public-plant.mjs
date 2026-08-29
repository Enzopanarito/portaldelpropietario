import engine from './_shared/_plant_engine.js';
import storeModule from './_shared/_plant_store.js';
import fixtureModule from './_shared/_plant_fixture.js';
import http from './_shared/_plant_http.js';
import ownerSession from './_shared/_owner_report_session.js';
import operationGuard from './_shared/_operation_guard.js';

function environment() {
  const context = String(Netlify.env.get('CONTEXT') || '').trim().toLowerCase();
  if (['deploy-preview', 'branch-deploy', 'dev', 'local'].includes(context)) return context;
  return String(Netlify.env.get('VLA_DATA_ENVIRONMENT') || context || '').trim().toLowerCase();
}
function isFixture(request) {
  const host = String(request?.headers?.get?.('host') || '').trim().toLowerCase();
  return ['staging', 'local', 'preview', 'deploy-preview', 'branch-deploy', 'dev'].includes(environment()) || /^deploy-preview-\d+--/.test(host);
}
function configuredStore() {
  return storeModule.createPlantStore({ token: Netlify.env.get('AIRTABLE_API_TOKEN'), baseId: Netlify.env.get('AIRTABLE_BASE_ID') });
}
async function context(fixture) { return fixture ? fixtureModule.createPlantFixture(new Date()) : storeModule.loadPlantContext(configuredStore()); }

const REQUEST_TYPES = new Set(['SUSPENSION', 'REINCORPORACION', 'CAMBIO_MODALIDAD', 'RENUNCIA', 'CAMBIO_PROPIETARIO']);
function caracasDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function cleanText(value, max = 1000) { return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max); }
function sessionEvent(request) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  return { headers };
}

export default async function handler(request) {
  if (!['GET', 'POST'].includes(request.method)) return http.json(405, { message: 'Method Not Allowed' });
  const fixture = isFixture(request);
  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (_) { return http.json(400, { message: 'Solicitud JSON inválida.' }); }
    if (cleanText(body.website, 10)) return http.json(202, { success: true, received: true });
  }
  const ownerId = String(request.method === 'GET' ? url.searchParams.get('ownerId') : body.ownerId || '').trim();
  if (!storeModule.validRecordId(ownerId)) return http.json(400, { message: 'Debe indicar un propietario válido.' });
  if (!fixture && !ownerSession.sessionFromEvent(sessionEvent(request), ownerId)) {
    return http.json(401, {
      success: false,
      code: 'OWNER_VERIFICATION_REQUIRED',
      verificationRequired: true,
      message: 'Verifica esta casa con el código enviado al correo registrado para consultar su información privada.'
    });
  }
  let requestOperation = null, requestCreated = false, requestId = '', requestGuardKey = '';
  try {
    const data = await context(fixture);
    const owner = data.owners.find(item => item.id === ownerId);
    if (!owner) return http.json(404, { message: 'Propietario no encontrado.' });
    const view = engine.ownerPlantView({ ownerId, profiles: data.profiles, interventions: data.interventions, recognizedPayments: data.recognizedPayments, at: new Date() });
    if (request.method === 'POST') {
      const requestedPlan = cleanText(body.requestedPlan, 80).toUpperCase(), reason = cleanText(body.reason, 1000), today = caracasDay();
      if (body.confirmation !== 'SOLICITAR_CAMBIO_PLANTA') return http.json(400, { message: 'Debe confirmar el envío de la solicitud.' });
      if (!requestedPlan) return http.json(400, { message: 'Seleccione exactamente qué gastos de planta mantendrá. Actualice la página si todavía ve el formulario anterior.' });
      if (view.current.specialAgreement || view.current.reinstatementMode === engine.REINSTATEMENT_MODE.NOT_ALLOWED) return http.json(409, { message: 'Esta casa tiene un acuerdo especial protegido. El cambio debe ser revisado directamente por Administración.' });
      let requestedPolicy;
      try { requestedPolicy = engine.participationPlanPolicy(requestedPlan); } catch (_) { return http.json(400, { message: 'La modalidad de planta seleccionada no es válida.' }); }
      if (requestedPlan === view.current.participationPlan) return http.json(409, { message: 'La casa ya tiene esa modalidad de planta.' });
      const type = engine.requestTypeForParticipationPlan(view.current, requestedPlan);
      if (!REQUEST_TYPES.has(type)) return http.json(400, { message: 'Tipo de solicitud inválido.' });
      if (reason.length < 10) return http.json(400, { message: 'Explique el motivo con al menos 10 caracteres.' });
      const proposedEffectiveDate = body.proposedEffectiveDate ? engine.isoDay(body.proposedEffectiveDate) : today;
      if (proposedEffectiveDate < today) return http.json(400, { message: 'La fecha propuesta no puede ser anterior a hoy.' });
      const idempotencyKey = engine.requestIdempotencyKey({ ownerId, type, requestedPlan, proposedEffectiveDate, day: today });
      requestGuardKey = idempotencyKey;
      const prior = (data.requests || []).find(item => item.idempotencyKey === idempotencyKey);
      if (prior) return http.json(200, { success: true, idempotent: true, requestId: prior.requestId, state: prior.state, message: 'Esta solicitud ya fue recibida. No se duplicó.' });
      requestId = `PLS-${owner.house}-${today.replaceAll('-', '')}-${idempotencyKey.slice(0, 10).toUpperCase()}`;
      if (!fixture) {
        const guard = await operationGuard.begin('PLANT_OWNER_REQUEST', idempotencyKey);
        if (!guard.ok) {
          if (guard.reason === 'done') return http.json(200, { success: true, idempotent: true, requestId: guard.marker?.resultId || requestId, state: 'RECIBIDA', message: 'Esta solicitud ya fue recibida. No se duplicó.' });
          return http.json(409, { success: false, protected: true, message: 'La solicitud ya está en proceso. Espera unos segundos antes de actualizar.' });
        }
        requestOperation = guard.marker;
      }
      const fields = storeModule.requestFields({
        requestId, ownerId, house: owner.house, type, state: 'RECIBIDA', requestedAt: new Date().toISOString(),
        proposedEffectiveDate, currentProfile: view.current, estimatedRetroactive: view.reinstatement.total,
        calculation: {
          ...view.reinstatement,
          policyVersion: 'plant-participation-plans-v1',
          requestedPlan,
          requestedPolicy
        },
        reason, conditions: requestedPolicy.servicioResidencialActivo
          ? (view.reinstatement.total > 0 ? 'Reincorporación sujeta al pago exacto del acumulado y confirmación administrativa.' : 'Reincorporación sin acumulado pendiente; no requiere pago previo, pero sí confirmación administrativa.')
          : 'El servicio quedará suspendido desde la fecha que confirme Administración. Los gastos se aplicarán según la modalidad seleccionada.',
        idempotencyKey
      });
      if (!fixture) {
        await configuredStore().createRecords(storeModule.TABLES.requests, [fields]);
        requestCreated = true;
        await operationGuard.setState(requestOperation, 'PLANT_OWNER_REQUEST', idempotencyKey, 'DONE', requestId);
      }
      return http.json(201, {
        success: true, requestId, state: 'RECIBIDA', type, previewOnly: fixture, requestedPlan, requestedPolicy,
        estimatedRetroactive: view.reinstatement.total,
        message: 'Solicitud recibida con la modalidad exacta. No cambia saldos ni servicio hasta la confirmación administrativa.'
      }, fixture ? { 'X-Preview-Isolated': 'true' } : {});
    }
    return http.json(200, { success: true, dataEnvironment: fixture ? 'preview-fixture' : 'production', ...view }, fixture ? { 'X-Preview-Isolated': 'true' } : {});
  } catch (error) {
    if (requestOperation) await operationGuard.setState(requestOperation, 'PLANT_OWNER_REQUEST', requestGuardKey, requestCreated ? 'PARTIAL' : 'ERROR', requestId).catch(() => null);
    const notReady = /NOT_FOUND|UNKNOWN_FIELD|UNKNOWN_TABLE|PLANT_PROFILE_MISSING/i.test(http.safeError(error));
    return http.json(notReady ? 503 : 500, { success: false, moduleReady: !notReady, message: notReady ? 'El módulo de planta aún no ha completado su migración segura.' : 'No se pudo consultar la información de la planta.', detail: http.safeError(error) });
  }
}

export const config = { path: '/api/vla/plant', method: ['GET', 'POST'] };
