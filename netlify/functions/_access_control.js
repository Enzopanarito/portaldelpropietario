'use strict';

// Motor central del control automático de acceso cómodo al portón.
// Regla: el acceso se decide exclusivamente por deuda anterior vencida,
// nunca por cargos corrientes ni por el recargo del mes en curso.

const { sendMail } = require('./_mailer');
const { calculateOwnerBalance, money } = require('./_balance_engine_v4');

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago',
  config: 'Configuración'
};

const TOLERANCE = 0.01;
const ACCESS_MODE_FIELD = 'Modo Control Portón';
const ACCESS_MODE_AUTO = 'Automático';
const ACCESS_MODE_MANUAL = 'Manual';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function nowCaracas() {
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}

function baseUrl() {
  return (process.env.MKJ_BASE_URL || 'https://cloud.mkjoules.com').replace(/\/$/, '');
}

function orgId() {
  return process.env.MKJ_ORG_ID || '1053';
}

function requiredAccessEnv() {
  const missing = [];
  if (!process.env.AIRTABLE_API_TOKEN) missing.push('AIRTABLE_API_TOKEN');
  if (!process.env.AIRTABLE_BASE_ID) missing.push('AIRTABLE_BASE_ID');
  if (!process.env.MKJ_ADMIN_EMAIL) missing.push('MKJ_ADMIN_EMAIL');
  if (!process.env.MKJ_ADMIN_PASSWORD) missing.push('MKJ_ADMIN_PASSWORD');
  return missing;
}

function airtableBaseUrl(tableName, suffix = '') {
  return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}${suffix}`;
}

async function airtableListAll(tableName, query = '') {
  let records = [];
  let offset = null;
  do {
    const separator = query ? '&' : '?';
    const url = airtableBaseUrl(tableName, `${query || ''}${offset ? `${separator}offset=${encodeURIComponent(offset)}` : ''}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function airtableGetRecord(tableName, recordId) {
  const response = await fetch(airtableBaseUrl(tableName, '/' + encodeURIComponent(recordId)), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error leyendo ${tableName}`);
  return data;
}

async function airtablePatchRecord(tableName, recordId, fields) {
  const response = await fetch(airtableBaseUrl(tableName, '/' + encodeURIComponent(recordId)), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error actualizando ${tableName}`);
  return data;
}

async function airtableCreateRecord(tableName, fields) {
  const response = await fetch(airtableBaseUrl(tableName), {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error creando ${tableName}`);
  return (data.records || [])[0] || null;
}

function normalizeAccessMode(value) {
  return String(value || '').trim().toLowerCase() === 'manual' ? ACCESS_MODE_MANUAL : ACCESS_MODE_AUTO;
}

async function getAccessMode() {
  const records = await airtableListAll(TABLES.config);
  const record = records[0] || null;
  const mode = normalizeAccessMode(record && record.fields ? record.fields[ACCESS_MODE_FIELD] : ACCESS_MODE_AUTO);
  return { mode, recordId: record ? record.id : null };
}

async function setAccessMode(mode) {
  const normalized = normalizeAccessMode(mode);
  const current = await getAccessMode();
  if (!current.recordId) throw new Error('No existe registro de Configuración para guardar el modo del portón.');
  const updated = await airtablePatchRecord(TABLES.config, current.recordId, { [ACCESS_MODE_FIELD]: normalized });
  return { mode: normalized, record: updated };
}

function extractCookie(setCookieHeaders) {
  const raw = Array.isArray(setCookieHeaders) ? setCookieHeaders.join(',') : String(setCookieHeaders || '');
  const match = raw.match(/access_token=[^;]+/);
  return match ? match[0] : '';
}

async function mkjLogin() {
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: process.env.MKJ_ADMIN_EMAIL, password: process.env.MKJ_ADMIN_PASSWORD })
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  const cookie = extractCookie(response.headers.get('set-cookie'));
  if (!response.ok || !cookie) throw new Error(`Login MKJ falló: HTTP ${response.status}${data?.message ? ' - ' + data.message : ''}`);
  return { cookie, status: response.status };
}

async function mkjSetMemberStatus(memberId, action) {
  const login = await mkjLogin();
  const response = await fetch(`${baseUrl()}/api/organizations/${encodeURIComponent(orgId())}/members/${encodeURIComponent(memberId)}/${action}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: login.cookie,
      Referer: `${baseUrl()}/admin/users/${encodeURIComponent(memberId)}`
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text || null; }
  if (!response.ok) throw new Error(`MKJ ${action} falló: HTTP ${response.status}${data?.message ? ' - ' + data.message : ''}`);
  return { status: response.status, data };
}

function ownerLinkIncludes(record, fieldName, ownerId) {
  const links = (record.fields || {})[fieldName] || [];
  return Array.isArray(links) && links.includes(ownerId);
}

function equivalentUsd(fields, primary, fallback) {
  return money(Number(fields[primary] || fields[fallback] || 0));
}

function calculateExpiredAccessDebt(owner, pagos, reportes) {
  // Se reutiliza el mismo motor auditado del portal/admin/cierre, pero sin gastos del mes.
  // Así solo sobreviven las bolsas de deuda anterior después de aplicar los pagos activos.
  const balance = calculateOwnerBalance(owner, [], pagos || []);
  const expiredUsd = money(Math.max(0, balance.expiredUsd));
  const expiredBsRef = money(Math.max(0, balance.expiredBsRef));

  let pendingUsd = 0;
  let pendingBsRef = 0;
  let pendingLegacy = 0;
  for (const report of reportes || []) {
    const fields = report.fields || {};
    if (fields.Estado !== 'Pendiente') continue;
    if (!ownerLinkIncludes(report, 'Propietario que Reporta', owner.id)) continue;
    const mode = String(fields['Forma de Pago Reportada'] || '').trim();
    const amount = equivalentUsd(fields, 'Equivalente USD Reportado', 'Monto Reportado');
    if (mode === 'USD') pendingUsd = money(pendingUsd + amount);
    else if (mode === 'Bs BCV') pendingBsRef = money(pendingBsRef + amount);
    else pendingLegacy = money(pendingLegacy + amount);
  }

  // Reportes históricos sin moneda conservan el mismo orden que los pagos históricos:
  // primero deuda Bs y luego deuda USD. Los reportes explícitos nunca cruzan monedas.
  let missingBsRef = money(Math.max(0, expiredBsRef - pendingBsRef));
  let legacyRemaining = pendingLegacy;
  const legacyToBs = Math.min(missingBsRef, legacyRemaining);
  missingBsRef = money(missingBsRef - legacyToBs);
  legacyRemaining = money(legacyRemaining - legacyToBs);
  let missingUsd = money(Math.max(0, expiredUsd - pendingUsd));
  const legacyToUsd = Math.min(missingUsd, legacyRemaining);
  missingUsd = money(missingUsd - legacyToUsd);

  const pendingTotal = money(pendingUsd + pendingBsRef + pendingLegacy);
  return {
    expiredUsd,
    expiredBsRef,
    expiredTotal: money(expiredUsd + expiredBsRef),
    pendingUsd,
    pendingBsRef,
    pendingLegacy,
    pendingTotal,
    hasExpiredDebt: expiredUsd > TOLERANCE || expiredBsRef > TOLERANCE,
    pendingCoversExpiredDebt: missingUsd <= TOLERANCE && missingBsRef <= TOLERANCE,
    missingUsd,
    missingBsRef
  };
}

function accessDebtText(calc) {
  const parts = [];
  if (calc.expiredUsd > TOLERANCE) parts.push(`USD $${calc.expiredUsd.toFixed(2)}`);
  if (calc.expiredBsRef > TOLERANCE) parts.push(`Bs ref. $${calc.expiredBsRef.toFixed(2)}`);
  return parts.length ? parts.join(' y ') : 'sin deuda vencida';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function limitationEmailHtml(owner, calc) {
  const fields = owner.fields || {};
  const name = escapeHtml(fields.Propietario || 'propietario(a)');
  const house = escapeHtml(fields.Casa || '');
  return `
  <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55">
    <p>Estimado(a) ${name},</p>
    <p>Reciba un cordial saludo.</p>
    <p>Por medio del presente le informamos que, de acuerdo con nuestros registros administrativos, su inmueble presenta una deuda vencida pendiente con el condominio Villas Los Apamates.</p>
    <p>Por tal motivo, el sistema administrativo ha limitado <b>automáticamente</b> el acceso cómodo al portón eléctrico mediante control, aplicación o sistema automatizado.</p>
    <p>Esta medida no impide el acceso a la urbanización, pero sí restringe el uso del sistema cómodo de apertura hasta tanto sea regularizada la situación administrativa.</p>
    <p>Una vez reportado el pago correspondiente a la deuda vencida, el sistema podrá habilitar <b>automáticamente</b> el acceso cómodo mientras la administración verifica el pago.</p>
    <p>Le agradecemos ponerse al día lo antes posible o reportar su pago a través del portal para que podamos validar la información y solventar la situación.</p>
    <p style="font-size:13px;color:#475569"><b>Referencia administrativa:</b> Casa ${house}. Deuda vencida registrada: ${escapeHtml(accessDebtText(calc))}.</p>
    <p>Atentamente,</p>
    <p><b>Administración<br>Villas Los Apamates</b></p>
  </div>`;
}

async function sendLimitationEmail(owner, calc) {
  const fields = owner.fields || {};
  const to = fields.Email || fields['MKJ Email'];
  if (!to) return { sent: false, status: 'Sin correo del propietario' };
  return sendMail({
    to,
    subject: 'Notificación automática de limitación de acceso cómodo al portón',
    html: limitationEmailHtml(owner, calc)
  });
}

async function loadAccessContext() {
  const [owners, pagos, reportes] = await Promise.all([
    airtableListAll(TABLES.propietarios),
    airtableListAll(TABLES.pagos),
    airtableListAll(TABLES.reportes)
  ]);
  return { owners, pagos, reportes };
}

async function syncOwnerAccess(ownerId, options = {}, context = null) {
  const missing = requiredAccessEnv();
  if (missing.length) throw new Error('Faltan variables privadas: ' + missing.join(', '));

  const modeInfo = await getAccessMode();
  if (modeInfo.mode === ACCESS_MODE_MANUAL && options.ignoreMode !== true) {
    return { ownerId, skipped: true, action: 'manual-mode', mode: ACCESS_MODE_MANUAL, reason: 'Control automático del portón en modo Manual. No se ejecutó sincronización automática.' };
  }

  const ctx = context || await loadAccessContext();
  let owner = (ctx.owners || []).find(item => item.id === ownerId);
  if (!owner) owner = await airtableGetRecord(TABLES.propietarios, ownerId);

  const fields = owner.fields || {};
  const memberId = String(options.mkjUserId || fields['MKJ User ID'] || '').trim();
  const previousStatus = fields['Estado Acceso Portón'] || 'Sin configurar';
  const calc = calculateExpiredAccessDebt(owner, ctx.pagos, ctx.reportes);
  const runMkj = options.runMkj !== false;

  if (!memberId) {
    return { ownerId, casa: fields.Casa, propietario: fields.Propietario, skipped: true, reason: 'Sin MKJ User ID', mode: modeInfo.mode, calc };
  }

  if (fields['Excepción Acceso'] === true) {
    const patched = await airtablePatchRecord(TABLES.propietarios, owner.id, {
      'Estado Acceso Portón': 'Excepción Manual',
      'Última Sync MKJ': nowCaracas(),
      'Motivo Limitación Acceso': 'Omitido por excepción manual de acceso.'
    });
    return { ownerId, casa: fields.Casa, propietario: fields.Propietario, action: 'skip-exception', estado: 'Excepción Manual', mode: modeInfo.mode, calc, owner: patched };
  }

  let desiredAction = 'enable';
  let desiredStatus = 'Habilitado';
  let reason = 'Sin deuda vencida pendiente. Acceso cómodo habilitado.';
  let temporary = false;

  if (calc.hasExpiredDebt && calc.pendingCoversExpiredDebt) {
    temporary = true;
    reason = `Habilitación temporal automática por reporte de pago pendiente suficiente para cubrir deuda vencida (${accessDebtText(calc)}).`;
  } else if (calc.hasExpiredDebt) {
    desiredAction = 'disable';
    desiredStatus = 'Limitado';
    reason = options.reason || `Limitación automática por deuda vencida pendiente (${accessDebtText(calc)}).`;
  }

  let mkjResult = null;
  const shouldCallMkj = runMkj && (options.forceMkj || previousStatus !== desiredStatus);
  if (shouldCallMkj) mkjResult = await mkjSetMemberStatus(memberId, desiredAction);

  const patched = await airtablePatchRecord(TABLES.propietarios, owner.id, {
    'Estado Acceso Portón': desiredStatus,
    'Última Sync MKJ': nowCaracas(),
    'Motivo Limitación Acceso': reason
  });

  let email = null;
  if (desiredStatus === 'Limitado' && previousStatus !== 'Limitado' && options.sendEmail !== false) {
    email = await sendLimitationEmail(owner, calc).catch(error => ({ sent: false, status: 'Error correo', detail: error.message }));
  }

  return {
    ownerId: owner.id,
    casa: fields.Casa,
    propietario: fields.Propietario,
    mkjUserId: memberId,
    previousStatus,
    estado: desiredStatus,
    action: desiredAction,
    temporary,
    mode: modeInfo.mode,
    reason,
    mkjStatus: mkjResult ? mkjResult.status : 'sin-cambio',
    email,
    calc,
    owner: patched
  };
}

async function autoSyncAll(options = {}) {
  const modeInfo = await getAccessMode();
  if (modeInfo.mode === ACCESS_MODE_MANUAL && options.ignoreMode !== true) {
    return {
      success: true,
      mode: ACCESS_MODE_MANUAL,
      skipped: true,
      total: 0,
      limited: 0,
      enabled: 0,
      errors: 0,
      message: 'Control automático del portón en modo Manual. No se ejecutó sincronización automática.',
      results: []
    };
  }

  const context = await loadAccessContext();
  const results = [];
  for (const owner of context.owners.sort((a, b) => Number((a.fields || {}).Casa || 0) - Number((b.fields || {}).Casa || 0))) {
    try {
      results.push(await syncOwnerAccess(owner.id, options, context));
    } catch (error) {
      results.push({ ownerId: owner.id, casa: owner.fields?.Casa, propietario: owner.fields?.Propietario, error: error.message });
    }
  }
  return {
    success: true,
    mode: modeInfo.mode,
    total: results.length,
    limited: results.filter(result => result.estado === 'Limitado').length,
    enabled: results.filter(result => result.estado === 'Habilitado').length,
    skipped: results.filter(result => result.skipped || result.action === 'skip-exception').length,
    errors: results.filter(result => result.error).length,
    results
  };
}

module.exports = {
  json,
  money,
  nowCaracas,
  requiredAccessEnv,
  airtableGetRecord,
  airtableCreateRecord,
  airtablePatchRecord,
  getAccessMode,
  setAccessMode,
  loadAccessContext,
  calculateExpiredAccessDebt,
  syncOwnerAccess,
  autoSyncAll,
  mkjLogin,
  mkjSetMemberStatus,
  TABLES,
  ACCESS_MODE_AUTO,
  ACCESS_MODE_MANUAL
};
