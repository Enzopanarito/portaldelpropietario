const { withAirtableUsage } = require('./_airtable_meter');
// netlify/functions/mkj-access.js
// Integración MKJoules: login automático + enable/disable de usuarios por ID.
// Las credenciales se leen únicamente desde variables privadas de Netlify.

const { requireAdmin } = require('./_auth');
const { mkjLogin, mkjSetMemberStatus } = require('./_mkj_client');
const {
  getAccessMode, getAutomationRules, loadAccessContext, calculateExpiredAccessDebt,
  syncOwnerAccess, ACCESS_MODE_AUTO
} = require('./_access_control');
const { evaluateManualAccessRequest } = require('./_manual_access_policy');

const TABLE_PROPIETARIOS = 'Propietarios';
const ALLOWED_ACTIONS = new Set(['enable', 'disable', 'clear-exception', 'test-login']);

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function requiredEnv() {
  const missing = [];
  if (!process.env.MKJ_ADMIN_EMAIL) missing.push('MKJ_ADMIN_EMAIL');
  if (!process.env.MKJ_ADMIN_PASSWORD) missing.push('MKJ_ADMIN_PASSWORD');
  if (!process.env.AIRTABLE_API_TOKEN) missing.push('AIRTABLE_API_TOKEN');
  if (!process.env.AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  return missing;
}

function airtableUrl(path = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_PROPIETARIOS)}${path}`;
}

async function airtableGetOwner(ownerId) {
  const response = await fetch(airtableUrl('/' + encodeURIComponent(ownerId)), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'No se pudo leer propietario en Airtable.');
  return data;
}

async function airtablePatchOwner(ownerId, fields) {
  const response = await fetch(airtableUrl('/' + encodeURIComponent(ownerId)), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'No se pudo actualizar propietario en Airtable.');
  return data;
}

function nowCaracas() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' });

  const missing = requiredEnv();
  if (missing.length) return json(500, { success: false, message: 'Faltan variables privadas en Netlify.', missing });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }

  const action = String(body.action || '').trim();
  if (!ALLOWED_ACTIONS.has(action)) return json(400, { success: false, message: 'Acción inválida.' });

  try {
    if (action === 'test-login') {
      const login = await mkjLogin();
      return json(200, { success: true, action, message: 'Login MKJoules exitoso.', mkjStatus: login.status });
    }

    const ownerId = body.ownerId;
    const rawMemberId = String(body.mkjUserId || '').trim();
    if (!ownerId) return json(400, { success: false, message: 'Debe indicar el propietario para que toda acción quede auditada.' });

    let owner = null;
    let memberId = rawMemberId;
    if (ownerId) {
      owner = await airtableGetOwner(ownerId);
      memberId = memberId || String(owner.fields?.['MKJ User ID'] || '').trim();
    }
    if (!memberId) return json(400, { success: false, message: 'Este propietario no tiene MKJ User ID configurado.' });

    if (action === 'clear-exception') {
      if (!ownerId || !owner) return json(400, { success:false, message:'Debe indicar el propietario.' });
      const modeInfo = await getAccessMode();
      if (modeInfo.mode !== ACCESS_MODE_AUTO) return json(409, { success:false, code:'AUTOMATIC_MODE_REQUIRED', message:'Active primero el modo Automático para devolver este propietario a la regla general.' });
      if (owner.fields?.['Excepción Acceso'] !== true) {
        return json(200, { success:true, action, idempotent:true, message:'El propietario ya estaba bajo la regla automática.' });
      }
      await airtablePatchOwner(ownerId, { 'Excepción Acceso':false, 'Motivo Limitación Acceso':'Excepción manual retirada. Reconciliación automática solicitada.' });
      try {
        const result = await syncOwnerAccess(ownerId, { forceMkj:true, sendEmail:false, reason:'Excepción manual retirada; estado reconciliado con la deuda vencida.' });
        return json(200, { success:true, action, message:'Excepción retirada y acceso reconciliado con la regla automática.', result });
      } catch (error) {
        await airtablePatchOwner(ownerId, { 'Excepción Acceso':true, 'Estado Acceso Portón':'Excepción Manual', 'Motivo Limitación Acceso':'Se conservó la excepción porque falló la reconciliación automática.' }).catch(()=>{});
        throw error;
      }
    }

    let policy = { allowed:true, exception:false };
    let accessCalc = null;
    if (ownerId && owner) {
      const modeInfo = await getAccessMode();
      if (modeInfo.mode === ACCESS_MODE_AUTO) {
        const [automationInfo, context] = await Promise.all([getAutomationRules(modeInfo), loadAccessContext()]);
        const financialOwner = context.owners.find(item => item.id === ownerId) || owner;
        accessCalc = calculateExpiredAccessDebt(financialOwner, context.pagos, context.reportes, {
          expenses:context.gastos || [],
          dueDay:automationInfo.rules.payment.dueDay,
          surchargeRate:automationInfo.rules.payment.surchargeRate
        });
      }
      policy = evaluateManualAccessRequest({
        action,
        mode:modeInfo.mode,
        hasExpiredDebt:Boolean(accessCalc?.hasExpiredDebt),
        hasException:owner.fields?.['Excepción Acceso'] === true,
        exceptionRequested:body.manualException === true,
        reason:body.reason
      });
      if (!policy.allowed) return json(409, { success:false, ...policy, calc:accessCalc });
    }

    const result = await mkjSetMemberStatus(memberId, action, {
      email: owner?.fields?.['MKJ Email'] || owner?.fields?.Email || ''
    });
    memberId = result.resolvedMemberId || memberId;
    const estado = policy.exception ? 'Excepción Manual' : (action === 'enable' ? 'Habilitado' : 'Limitado');
    const motivo = body.reason || (action === 'enable' ? 'Habilitación manual desde portal.' : 'Limitación manual desde portal.');

    let updatedOwner = null;
    if (ownerId) {
      const fields = {
        'Estado Acceso Portón': estado,
        'Última Sync MKJ': nowCaracas(),
        'Motivo Limitación Acceso': motivo
      };
      if (policy.createException) fields['Excepción Acceso'] = true;
      if (result.recoveredMemberId) fields['MKJ User ID'] = memberId;
      try {
        updatedOwner = await airtablePatchOwner(ownerId, fields);
      } catch (error) {
        if (policy.createException && result.idempotent !== true) {
          const rollbackAction = action === 'enable' ? 'disable' : 'enable';
          await mkjSetMemberStatus(memberId, rollbackAction, { email:owner?.fields?.['MKJ Email'] || owner?.fields?.Email || '' }).catch(()=>{});
        }
        throw error;
      }
    }

    return json(200, {
      success: true,
      action,
      mkjUserId: memberId,
      estado,
      manualException: policy.exception === true,
      accessCalc,
      mkjStatus: result.status,
      mkjUserIdRecovered: result.recoveredMemberId === true,
      mkjMembershipVerified: result.verifiedMembership === true,
      mkjMembershipSource: result.membershipSource || null,
      mkjAlreadyApplied: result.idempotent === true,
      mkjAuthMode: result.authMode,
      message: result.idempotent
        ? (action === 'enable'
          ? 'El acceso ya estaba habilitado en MKJoules; estado verificado y actualizado.'
          : 'El acceso ya estaba limitado en MKJoules; estado verificado y actualizado.')
        : (action === 'enable' ? 'Acceso habilitado en MKJoules.' : 'Acceso limitado en MKJoules.'),
      owner: updatedOwner ? { id: updatedOwner.id, fields: updatedOwner.fields } : null
    });
  } catch (error) {
    return json(500, { success: false, message: 'Error sincronizando con MKJoules.', detail: error.message });
  }
};

exports.handler = withAirtableUsage('mkj-access', handler);
