'use strict';

const { requireAdmin } = require('./_auth');
const engine = require('./_plant_engine');
const storeModule = require('./_plant_store');
const fixtureModule = require('./_plant_fixture');
const { safeDisplayText } = require('./_security_utils');

function defaultNotifyOwner(payload) {
  return require('./_plant_notifications').sendPlantProfileChange(payload);
}

function json(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: JSON.stringify(body) }; }
function fixtureEnvironment(env = process.env, event = null) {
  const values = [env.CONTEXT, env.VLA_DATA_ENVIRONMENT].map(value => String(value || '').trim().toLowerCase());
  const headers = event?.headers || {}, host = String(headers.host || headers.Host || '').trim().toLowerCase();
  return values.some(value => ['staging', 'local', 'preview', 'deploy-preview', 'branch-deploy', 'dev'].includes(value)) || /^deploy-preview-\d+--/.test(host);
}
function previousDay(value) { const date = new Date(`${engine.isoDay(value)}T12:00:00.000Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
function caracasDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
function createContextLoader(env = process.env, fixture = fixtureEnvironment(env)) {
  if (fixture) return async () => fixtureModule.createPlantFixture(new Date());
  const store = storeModule.createPlantStore({ token: env.AIRTABLE_API_TOKEN, baseId: env.AIRTABLE_BASE_ID });
  return () => storeModule.loadPlantContext(store);
}

function createHandler(deps = {}) {
  const injectedLoad = deps.loadContext || null;
  const notifyOwner = deps.notifyOwner || defaultNotifyOwner;
  return async function handler(event) {
    const auth = (deps.requireAdmin || requireAdmin)(event); if (!auth.ok) return auth.response;
    try {
      const env = deps.env || process.env, fixture = fixtureEnvironment(env, event);
      const load = injectedLoad || createContextLoader(env, fixture);
      const context = await load();
      if (event.httpMethod === 'GET') {
        const at = new Date();
        const simulations = context.owners.map(owner => {
          const ownerView = engine.ownerPlantView({ ownerId: owner.id, profiles: context.profiles, interventions: context.interventions, recognizedPayments: context.recognizedPayments, at });
          return {
            house: owner.house, ownerId: owner.id, ownerName: safeDisplayText(owner.name || `Casa ${owner.house}`, 180), hasEmail: Boolean(owner.email),
            profile: engine.profileAt(context.profiles, owner.id, at), reinstatement: ownerView.reinstatement,
            ownerView
          };
        });
        return json(200, {
          success: true, moduleVersion: 2, ownerViewContract: 'plant-owner-view-v1', readOnly: true, houses: simulations,
          participationSummary: engine.participationSummary({ owners: context.owners, profiles: context.profiles, at }),
          asset: (context.assets || [])[0] || null,
          interventionCount: context.interventions.length,
          interventions: context.interventions.map(item => ({
            interventionId: item.interventionId, date: item.date, category: item.category || item.snapshot?.category || '',
            description: item.description || item.snapshot?.concept || '', amountUsd: engine.money(item.amountUsd || item.snapshot?.totalAmount),
            historicalOnly: Boolean(item.historicalOnly), source: item.source || '', voided: Boolean(item.voided),
            publicDocumentUrl: item.publicDocumentUrl || '', documents: item.documents || []
          })).sort((a, b) => String(b.date).localeCompare(String(a.date))),
          requests: (context.requests || []).map(item => ({
            requestId: item.requestId, ownerId: item.ownerId, house: item.house, type: item.type, state: item.state,
            requestedAt: item.requestedAt, proposedEffectiveDate: item.proposedEffectiveDate,
            estimatedRetroactive: item.estimatedRetroactive, officialRetroactive: item.officialRetroactive,
            conditions: item.conditions, reason: item.reason, paymentComplete: item.paymentComplete,
            definitivePaymentId: item.definitivePaymentId
          })).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
        });
      }
      if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });
      let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { message: 'Solicitud JSON inválida.' }); }
      if (body.action === 'preview-expense') {
        if (body.type === 'Gasto Común') return json(400, { message: 'Los gastos de planta deben registrarse como Gasto Especial para mantenerlos fuera del pronto pago. El factor común aún no está aprobado.' });
        const classification = engine.inferPlantExpense(body.concept);
        if (!classification.isPlant && !body.category) return json(400, { message: 'El concepto no parece corresponder a la planta. Puede elegir la categoría manualmente.' });
        const snapshot = engine.buildExpenseSnapshot({
          owners: context.owners, profiles: context.profiles, effectiveDate: body.effectiveDate || new Date(), classification,
          explicitCategory: body.category || undefined,
          explicitRetroactive: typeof body.generatesRetroactive === 'boolean' ? body.generatesRetroactive : undefined,
          expense: { concept: body.concept, amount: body.amount, type: body.type || 'Gasto Especial', mode: body.mode || 'Bs BCV' }
        });
        return json(200, {
          success: true, readOnly: true, classification, snapshotHash: snapshot.snapshotHash,
          category: snapshot.category, generatesRetroactive: snapshot.generatesRetroactive, allocationRule: snapshot.allocationRule,
          totalAmount: snapshot.totalAmount, assignedAmount: snapshot.totals.assignedAmount,
          included: snapshot.participants.filter(item => item.included).map(item => ({ house: item.house, ownerId: item.ownerId, amount: item.amount, profileState: item.profileState })),
          excluded: snapshot.participants.filter(item => !item.included).map(item => ({ house: item.house, ownerId: item.ownerId, reason: item.reason, theoreticalRetroactiveAmount: item.theoreticalRetroactiveAmount, profileState: item.profileState })),
          snapshot
        });
      }
      const store = deps.store || (fixture ? null : storeModule.createPlantStore({ token: env.AIRTABLE_API_TOKEN, baseId: env.AIRTABLE_BASE_ID }));
      const actor = safeDisplayText(auth.claims?.jti || 'ADMIN', 120), now = new Date().toISOString();
      if (body.action === 'create-profile-version') {
        if (body.confirmation !== 'CONFIRMAR_CAMBIO_PLANTA') return json(400, { message: 'Debe confirmar explícitamente el cambio manual de condición de planta.' });
        const ownerId = String(body.ownerId || '').trim(), owner = context.owners.find(item => item.id === ownerId);
        if (!owner) return json(400, { message: 'Propietario inválido.' });
        const reason = safeDisplayText(body.reason, 500), effectiveFrom = engine.isoDay(body.effectiveFrom);
        const today = caracasDay();
        if (reason.length < 5) return json(400, { message: 'Indique el motivo del cambio.' });
        if (effectiveFrom < today) return json(400, { message: 'La fecha no puede ser anterior a hoy; no se permiten exclusiones retroactivas.' });
        const existingVersion = context.profiles.find(item => item.ownerId === ownerId && item.effectiveFrom === effectiveFrom);
        if (existingVersion) return json(200, { success: true, idempotent: true, previewOnly: fixture, profile: existingVersion, message: 'Ya existe una versión programada para esa fecha. No se duplicó.' });
        const current = engine.profileAt(context.profiles, ownerId, effectiveFrom);
        if (!current) return json(409, { message: 'No existe un perfil vigente que pueda versionarse.' });
        const flags = body.profile || {};
        const booleanNames = ['participaReparaciones', 'participaMantenimiento', 'participaGasoilResidencial', 'participaBeneficioComun', 'servicioResidencialActivo'];
        if (booleanNames.some(name => typeof flags[name] !== 'boolean')) return json(400, { message: 'Todas las reglas de participación deben confirmarse explícitamente.' });
        const version = Math.max(0, ...context.profiles.filter(item => item.ownerId === ownerId).map(item => Number(item.version || 0))) + 1;
        const nextProfile = context.profiles.filter(item => item.ownerId === ownerId && engine.isoDay(item.effectiveFrom) > effectiveFrom)
          .sort((left, right) => engine.isoDay(left.effectiveFrom).localeCompare(engine.isoDay(right.effectiveFrom)))[0] || null;
        const profile = engine.validateProfile({
          ...current, ...flags, ownerId, house: owner.house, state: String(flags.state || ''),
          reinstatementMode: String(flags.reinstatementMode || ''), effectiveFrom, effectiveTo: nextProfile ? previousDay(nextProfile.effectiveFrom) : null,
          profileId: `PLP-${owner.house}-${effectiveFrom}-V${version}`, reason, approvedBy: actor, approvedAt: now,
          observations: safeDisplayText(flags.observations, 1000), specialAgreement: Boolean(flags.specialAgreement),
          active: true, version, replacesProfileId: current.profileId
        });
        const conditionFields = ['state', 'reinstatementMode', 'participaReparaciones', 'participaMantenimiento', 'participaGasoilResidencial', 'participaBeneficioComun', 'servicioResidencialActivo', 'specialAgreement', 'observations'];
        if (conditionFields.every(field => profile[field] === current[field])) return json(400, { message: 'No hay ningún cambio de condición para confirmar.' });
        if (!current.servicioResidencialActivo && profile.servicioResidencialActivo) {
          const reinstatementRequestId = String(body.reinstatementRequestId || '').trim();
          const fulfilled = (context.requests || []).find(item => item.requestId === reinstatementRequestId && item.ownerId === ownerId && item.type === 'REINCORPORACION' && item.state === 'CUMPLIDA' && item.paymentComplete && item.definitivePaymentId);
          if (!fulfilled) return json(409, { message: 'No puede activar el servicio: falta una solicitud de reincorporación cumplida y vinculada a un pago definitivo exacto.' });
          if (context.profiles.some(item => item.reinstatementRequestId === fulfilled.requestId)) return json(409, { message: 'Esa solicitud de reincorporación ya fue utilizada en otra versión del perfil.' });
          profile.reinstatementRequestId = fulfilled.requestId;
        }
        const previousEffectiveDay = previousDay(effectiveFrom);
        let notification = { sent: false, status: 'Vista previa aislada', detail: 'No se envían correos desde un deploy de prueba.', recipientConfigured: Boolean(owner.email) };
        if (!fixture) {
          await store.createRecords(storeModule.TABLES.profiles, [storeModule.profileFields(profile)]);
          if (current.recordId) await store.patchRecords(storeModule.TABLES.profiles, [{ id: current.recordId, fields: { 'Fecha Fin Estado': previousEffectiveDay } }]);
          const audit = { eventId: `PLA-${engine.hash(profile).slice(0, 20).toUpperCase()}`, entity: 'PERFIL', entityId: profile.profileId, action: 'CREAR_VERSION', before: current, after: profile, actor, at: now, reason };
          audit.hash = engine.hash(audit); await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(audit)]);
          try {
            notification = await notifyOwner({ owner, profile, previousProfile: current, portalUrl: env.URL || 'https://villalosapamates.netlify.app/' });
          } catch (error) {
            notification = { sent: false, status: 'Error de envío', detail: safeDisplayText(error?.message || 'No fue posible enviar el correo.', 300), recipientConfigured: Boolean(owner.email) };
          }
          const notificationState = { sent: Boolean(notification.sent), status: safeDisplayText(notification.status, 120), recipientConfigured: notification.recipientConfigured !== false };
          const notificationAudit = {
            eventId: `PLA-${engine.hash({ profileId: profile.profileId, notificationState }).slice(0, 20).toUpperCase()}`,
            entity: 'PERFIL', entityId: profile.profileId, action: notification.sent ? 'NOTIFICAR_CAMBIO' : 'NOTIFICACION_PENDIENTE',
            before: null, after: notificationState, actor, at: new Date().toISOString(), reason: notification.sent ? 'Correo de cambio enviado' : notificationState.status
          };
          notificationAudit.hash = engine.hash(notificationAudit);
          try { await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(notificationAudit)]); } catch (_) { /* El perfil ya fue confirmado; el fallo de auditoría del correo no lo revierte. */ }
        }
        const message = fixture
          ? 'Vista previa confirmada: se crearía la versión sin recalcular gastos anteriores y sin enviar correo desde el entorno de prueba.'
          : notification.sent
            ? 'Cambio confirmado sin recalcular gastos anteriores. El propietario fue notificado por correo.'
            : `Cambio confirmado sin recalcular gastos anteriores. Correo pendiente: ${safeDisplayText(notification.status, 160)}.`;
        return json(201, { success: true, previewOnly: fixture, profile, notification: { sent: Boolean(notification.sent), status: notification.status, recipientConfigured: notification.recipientConfigured !== false }, message });
      }
      if (body.action === 'review-request') {
        const request = (context.requests || []).find(item => item.requestId === String(body.requestId || '').trim());
        if (!request) return json(404, { message: 'Solicitud no encontrada.' });
        const nextState = String(body.state || '').trim().toUpperCase();
        const allowed = new Set(['EN_REVISION', 'APROBADA_CONDICIONADA', 'PAGO_PENDIENTE', 'RECHAZADA', 'CANCELADA']);
        if (!allowed.has(nextState)) return json(400, { message: 'Estado de revisión inválido. El cumplimiento requiere pago definitivo y una nueva versión de perfil.' });
        const reason = safeDisplayText(body.reason, 500), conditions = safeDisplayText(body.conditions, 1000);
        if (reason.length < 5) return json(400, { message: 'Indique el motivo de la decisión.' });
        const official = engine.money(body.officialRetroactive ?? request.estimatedRetroactive);
        if (!fixture) {
          await store.patchRecords(storeModule.TABLES.requests, [{ id: request.recordId, fields: {
            Estado: nextState, 'Retroactivo Oficial': official, Condiciones: conditions,
            'Revisado Por': actor, 'Fecha Revisión': now, 'Actualizado En': now, Motivo: reason
          } }]);
          const after = { ...request, state: nextState, officialRetroactive: official, conditions, reason, reviewedBy: actor, reviewedAt: now };
          const audit = { eventId: `PLA-${engine.hash(after).slice(0, 20).toUpperCase()}`, entity: 'SOLICITUD', entityId: request.requestId, action: 'REVISAR', before: request, after, actor, at: now, reason, requestId: request.requestId };
          audit.hash = engine.hash(audit); await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(audit)]);
        }
        return json(200, { success: true, previewOnly: fixture, requestId: request.requestId, state: nextState, officialRetroactive: official, message: 'Revisión registrada sin modificar saldos.' });
      }
      if (body.action === 'confirm-reinstatement-payment') {
        const request = (context.requests || []).find(item => item.requestId === String(body.requestId || '').trim());
        if (!request || request.type !== 'REINCORPORACION') return json(404, { message: 'Solicitud de reincorporación no encontrada.' });
        if (!['APROBADA_CONDICIONADA', 'PAGO_PENDIENTE'].includes(request.state)) return json(409, { message: 'La solicitud debe estar aprobada o pendiente de pago.' });
        const paymentId = String(body.paymentId || '').trim(), payment = (context.payments || []).find(item => item.recordId === paymentId || item.paymentId === paymentId);
        if (!payment || payment.ownerId !== request.ownerId) return json(400, { message: 'El pago definitivo no pertenece a la casa solicitante.' });
        const official = engine.money(request.officialRetroactive || request.estimatedRetroactive);
        if (!(official > 0) || Math.abs(engine.money(payment.amount) - official) > 0.01) return json(409, { message: `El pago definitivo debe corresponder exactamente a ${official.toFixed(2)} USD.` });
        const reused = (context.requests || []).some(item => item.requestId !== request.requestId && item.paymentComplete && item.definitivePaymentId === payment.recordId);
        if (reused) return json(409, { message: 'Ese pago definitivo ya está vinculado a otra reincorporación.' });
        const after = { ...request, state: 'CUMPLIDA', definitivePaymentId: payment.recordId, paymentComplete: true, recognizedAmount: official, reviewedBy: actor, reviewedAt: now, updatedAt: now };
        if (!fixture) {
          await store.patchRecords(storeModule.TABLES.requests, [{ id: request.recordId, fields: {
            Estado: 'CUMPLIDA', 'Pago Definitivo ID': payment.recordId, 'Pago Cumplido': true,
            'Monto Reconocido': official, 'Revisado Por': actor, 'Fecha Revisión': now, 'Actualizado En': now
          } }]);
          const audit = { eventId: `PLA-${engine.hash(after).slice(0, 20).toUpperCase()}`, entity: 'REINCORPORACION', entityId: request.requestId, action: 'CONFIRMAR_PAGO_DEFINITIVO', before: request, after, actor, at: now, reason: 'Pago definitivo exacto verificado', requestId: request.requestId };
          audit.hash = engine.hash(audit); await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(audit)]);
        }
        return json(200, { success: true, previewOnly: fixture, requestId: request.requestId, state: 'CUMPLIDA', definitivePaymentId: payment.recordId, message: 'Pago definitivo verificado. Ya puede programarse una nueva versión del perfil.' });
      }
      if (body.action === 'update-asset-profile') {
        const current = (context.assets || [])[0] || null, input = body.asset || {};
        const technicalState = String(input.technicalState || 'PENDIENTE_FICHA'), allowedStates = new Set(['PENDIENTE_FICHA', 'OPERATIVA', 'MANTENIMIENTO_REQUERIDO', 'FUERA_DE_SERVICIO']);
        if (!allowedStates.has(technicalState)) return json(400, { message: 'Estado técnico inválido.' });
        const rawFactor = input.commonConsumptionFactor, factor = rawFactor === '' || rawFactor === null || rawFactor === undefined ? null : Number(rawFactor);
        if (factor !== null && (!Number.isFinite(factor) || factor < 0 || factor > 1)) return json(400, { message: 'El factor común debe estar entre 0 y 1 o permanecer vacío.' });
        if (input.commonConsumptionFactorApproved === true && factor === null) return json(400, { message: 'No puede aprobar el factor común sin una medición.' });
        const asset = {
          ...(current || {}), assetId: current?.assetId || 'PLANTA-PRINCIPAL', name: safeDisplayText(input.name || current?.name || 'Planta eléctrica', 200),
          type: 'GENERADOR_ELECTRICO', power: safeDisplayText(input.power, 120), brand: safeDisplayText(input.brand, 120),
          model: safeDisplayText(input.model, 120), serial: safeDisplayText(input.serial, 120), acquiredAt: input.acquiredAt ? engine.isoDay(input.acquiredAt) : '',
          installedAt: input.installedAt ? engine.isoDay(input.installedAt) : '', hourMeter: Math.max(0, Number(input.hourMeter || 0)),
          lastMaintenance: input.lastMaintenance ? engine.isoDay(input.lastMaintenance) : '', nextMaintenance: input.nextMaintenance ? engine.isoDay(input.nextMaintenance) : '',
          nextMaintenanceHours: Math.max(0, Number(input.nextMaintenanceHours || 0)), observations: safeDisplayText(input.observations, 3000),
          technicalState, commonConsumptionFactor: factor, commonConsumptionFactorApproved: input.commonConsumptionFactorApproved === true,
          updatedAt: now, updatedBy: actor, version: Number(current?.version || 0) + 1
        };
        if (!fixture) {
          const fields = storeModule.assetFields(asset);
          if (current?.recordId) await store.patchRecords(storeModule.TABLES.assets, [{ id: current.recordId, fields }]);
          else await store.createRecords(storeModule.TABLES.assets, [fields]);
          const audit = { eventId: `PLA-${engine.hash(asset).slice(0, 20).toUpperCase()}`, entity: 'ACTIVO', entityId: asset.assetId, action: 'ACTUALIZAR_FICHA_TECNICA', before: current, after: asset, actor, at: now, reason: safeDisplayText(body.reason || 'Actualización de ficha técnica', 500) };
          audit.hash = engine.hash(audit); await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(audit)]);
        }
        return json(200, { success: true, previewOnly: fixture, asset, message: 'Ficha técnica actualizada. El factor común no genera cargos por sí solo.' });
      }
      if (body.action === 'add-technical-history') {
        const date = engine.isoDay(body.date), description = safeDisplayText(body.description, 1000), category = String(body.category || engine.CATEGORY.OTHER);
        if (description.length < 5 || !Object.values(engine.CATEGORY).includes(category)) return json(400, { message: 'Complete fecha, descripción y categoría válidas.' });
        const publicDocumentUrl = safeDisplayText(body.publicDocumentUrl, 1000);
        if (publicDocumentUrl && !/^https:\/\//i.test(publicDocumentUrl)) return json(400, { message: 'El documento público debe usar una URL HTTPS.' });
        const documentUrls = Array.isArray(body.documentUrls) ? body.documentUrls.map(value => safeDisplayText(value, 1000)).filter(Boolean) : [];
        if (documentUrls.length > 6 || documentUrls.some(value => !/^https:\/\//i.test(value))) return json(400, { message: 'Los documentos deben ser hasta 6 URLs HTTPS válidas.' });
        const interventionId = `PLI-${date.replaceAll('-', '')}-${engine.hash({ date, description, now }).slice(0, 12).toUpperCase()}`;
        const fields = {
          'Intervención ID': interventionId, Fecha: date, Tipo: category === engine.CATEGORY.RESIDENTIAL_FUEL ? 'COMBUSTIBLE' : category,
          Categoría: category, Descripción: description, Diagnóstico: safeDisplayText(body.diagnosis, 2000),
          'Trabajo Realizado': safeDisplayText(body.work, 2000), Repuestos: safeDisplayText(body.spareParts, 1000),
          'Proveedor/Técnico': safeDisplayText(body.provider, 300), 'Monto USD': engine.money(body.amountUsd),
          'Monto Bs': engine.money(body.amountBs), 'Tasa BCV': Number(body.bcvRate || 0), Horómetro: Number(body.hourMeter || 0),
          ...(documentUrls.length ? { Documentos: documentUrls.map(url => ({ url })) } : {}),
          'Documento Público URL': publicDocumentUrl, Observaciones: safeDisplayText(body.observations, 2000),
          'Creado En': now, 'Registrado Por': actor, 'Regla Distribución': 'SOLO_INFORMATIVO',
          'Genera Retroactivo': false, 'Solo Historial': true, Estado: 'ACTIVO', Origen: 'ADMIN'
        };
        if (!fixture) {
          await store.createRecords(storeModule.TABLES.interventions, [fields]);
          const audit = { eventId: `PLA-${engine.hash(fields).slice(0, 20).toUpperCase()}`, entity: 'INTERVENCION', entityId: interventionId, action: 'CREAR_HISTORIAL_TECNICO', before: null, after: fields, actor, at: now, reason: 'Registro técnico informativo' };
          audit.hash = engine.hash(audit); await store.createRecords(storeModule.TABLES.audit, [storeModule.auditFields(audit)]);
        }
        return json(201, { success: true, previewOnly: fixture, interventionId, message: 'Historial técnico registrado sin generar cargos.' });
      }
      return json(400, { message: 'Acción no permitida.' });
    } catch (error) {
      return json(500, { success: false, message: 'No se pudo preparar la información de planta.', detail: safeDisplayText(error.message, 300) });
    }
  };
}

const handler = createHandler();
module.exports = { handler, createHandler, fixtureEnvironment, createContextLoader };
