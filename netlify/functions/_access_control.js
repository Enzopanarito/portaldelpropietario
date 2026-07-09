// netlify/functions/_access_control.js
// Motor central del control automático de acceso cómodo al portón.
// Regla: el acceso se decide por deuda vencida anterior, no por deuda corriente del mes.

const { sendMail } = require('./_mailer');

const TABLES = {
  propietarios: 'Propietarios',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago'
};

const TOLERANCE = 0.01;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}

function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
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
    const sep = query ? '&' : '?';
    const url = airtableBaseUrl(tableName, `${query || ''}${offset ? `${sep}offset=${encodeURIComponent(offset)}` : ''}`);
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

function extractCookie(setCookieHeaders) {
  const raw = Array.isArray(setCookieHeaders) ? setCookieHeaders.join(',') : String(setCookieHeaders || '');
  const match = raw.match(/access_token=[^;]+/);
  return match ? match[0] : '';
}

async function mkjLogin() {
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
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
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Cookie': login.cookie,
      'Referer': `${baseUrl()}/admin/users/${encodeURIComponent(memberId)}`
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
  const f = owner.fields || {};
  const initialUsd = Number(f['Deuda Anterior USD'] || 0);
  const initialBsRef = Number(f['Deuda Anterior Bs Ref'] || 0);
  const splitExists = Math.abs(initialUsd) > 0.001 || Math.abs(initialBsRef) > 0.001;

  // En modo viejo, Deuda Anterior se interpreta como vencida pagadera en Bs Ref.
  let expiredUsd = Math.max(0, initialUsd);
  let expiredBsRef = Math.max(0, initialBsRef + (!splitExists ? Number(f['Deuda Anterior'] || 0) : 0));

  // Pagos ya aplicados y no cerrados se aplican primero contra deuda vencida, según su moneda.
  (pagos || []).forEach(payment => {
    const pf = payment.fields || {};
    if (pf['[x] Aplicado al Cierre'] === true) return;
    if (!ownerLinkIncludes(payment, 'Propietario que Paga', owner.id)) return;
    const mode = pf['Forma de Pago'] || 'Bs BCV';
    const amount = equivalentUsd(pf, 'Equivalente USD Aplicado', 'Monto Pagado');
    if (mode === 'USD') expiredUsd = Math.max(0, money(expiredUsd - amount));
    else expiredBsRef = Math.max(0, money(expiredBsRef - amount));
  });

  let pendingUsd = 0;
  let pendingBsRef = 0;
  (reportes || []).forEach(report => {
    const rf = report.fields || {};
    if (rf.Estado !== 'Pendiente') return;
    if (!ownerLinkIncludes(report, 'Propietario que Reporta', owner.id)) return;
    const mode = rf['Forma de Pago Reportada'] || 'Bs BCV';
    const amount = equivalentUsd(rf, 'Equivalente USD Reportado', 'Monto Reportado');
    if (mode === 'USD') pendingUsd += amount;
    else pendingBsRef += amount;
  });

  pendingUsd = money(pendingUsd);
  pendingBsRef = money(pendingBsRef);

  const pendingCoversUsd = expiredUsd <= TOLERANCE || pendingUsd + TOLERANCE >= expiredUsd;
  const pendingCoversBs = expiredBsRef <= TOLERANCE || pendingBsRef + TOLERANCE >= expiredBsRef;

  return {
    expiredUsd: money(expiredUsd),
    expiredBsRef: money(expiredBsRef),
    expiredTotal: money(expiredUsd + expiredBsRef),
    pendingUsd,
    pendingBsRef,
    pendingTotal: money(pendingUsd + pendingBsRef),
    hasExpiredDebt: expiredUsd > TOLERANCE || expiredBsRef > TOLERANCE,
    pendingCoversExpiredDebt: pendingCoversUsd && pendingCoversBs,
    missingUsd: money(Math.max(0, expiredUsd - pendingUsd)),
    missingBsRef: money(Math.max(0, expiredBsRef - pendingBsRef))
  };
}

function accessDebtText(calc) {
  const parts = [];
  if (calc.expiredUsd > TOLERANCE) parts.push(`USD $${calc.expiredUsd.toFixed(2)}`);
  if (calc.expiredBsRef > TOLERANCE) parts.push(`Bs ref. $${calc.expiredBsRef.toFixed(2)}`);
  return parts.length ? parts.join(' y ') : 'sin deuda vencida';
}

function limitationEmailHtml(owner, calc) {
  const f = owner.fields || {};
  const name = f.Propietario || 'propietario(a)';
  return `
  <div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.55">
    <p>Estimado(a) ${name},</p>

    <p>Reciba un cordial saludo.</p>

    <p>Por medio del presente le informamos que, de acuerdo con nuestros registros administrativos, su inmueble presenta una deuda vencida pendiente con el condominio Villas Los Apamates.</p>

    <p>Por tal motivo, ha sido limitado temporalmente el acceso cómodo al portón eléctrico mediante control, aplicación o sistema automatizado.</p>

    <p>Esta medida no impide el acceso a la urbanización, pero sí restringe el uso del sistema cómodo de apertura hasta tanto sea regularizada la situación administrativa.</p>

    <p>Le agradecemos ponerse al día lo antes posible o reportar su pago a través del portal para que podamos validar la información y solventar la situación.</p>

    <p style="font-size:13px;color:#475569"><b>Referencia administrativa:</b> Casa ${f.Casa || ''}. Deuda vencida registrada: ${accessDebtText(calc)}.</p>

    <p>Atentamente,</p>
    <p><b>Administración<br>Villas Los Apamates</b></p>
  </div>`;
}

async function sendLimitationEmail(owner, calc) {
  const f = owner.fields || {};
  const to = f.Email || f['MKJ Email'];
  if (!to) return { sent: false, status: 'Sin correo del propietario' };
  return await sendMail({
    to,
    subject: 'Notificación de limitación de acceso cómodo al portón',
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

  const ctx = context || await loadAccessContext();
  let owner = (ctx.owners || []).find(o => o.id === ownerId);
  if (!owner) owner = await airtableGetRecord(TABLES.propietarios, ownerId);

  const f = owner.fields || {};
  const memberId = String(options.mkjUserId || f['MKJ User ID'] || '').trim();
  const previousStatus = f['Estado Acceso Portón'] || 'Sin configurar';
  const calc = calculateExpiredAccessDebt(owner, ctx.pagos, ctx.reportes);
  const runMkj = options.runMkj !== false;

  if (!memberId) {
    return { ownerId, casa: f.Casa, propietario: f.Propietario, skipped: true, reason: 'Sin MKJ User ID', calc };
  }

  if (f['Excepción Acceso'] === true) {
    const patched = await airtablePatchRecord(TABLES.propietarios, owner.id, {
      'Estado Acceso Portón': 'Excepción Manual',
      'Última Sync MKJ': nowCaracas(),
      'Motivo Limitación Acceso': 'Omitido por excepción manual de acceso.'
    });
    return { ownerId, casa: f.Casa, propietario: f.Propietario, action: 'skip-exception', estado: 'Excepción Manual', calc, owner: patched };
  }

  let desiredAction = 'enable';
  let desiredStatus = 'Habilitado';
  let reason = 'Sin deuda vencida pendiente. Acceso cómodo habilitado.';
  let temporary = false;

  if (calc.hasExpiredDebt && calc.pendingCoversExpiredDebt) {
    desiredAction = 'enable';
    desiredStatus = 'Habilitado';
    temporary = true;
    reason = `Habilitación temporal por reporte de pago pendiente suficiente para cubrir deuda vencida (${accessDebtText(calc)}).`;
  } else if (calc.hasExpiredDebt) {
    desiredAction = 'disable';
    desiredStatus = 'Limitado';
    reason = options.reason || `Limitación automática por deuda vencida pendiente (${accessDebtText(calc)}).`;
  }

  let mkjResult = null;
  const shouldCallMkj = runMkj && (options.forceMkj || previousStatus !== desiredStatus);
  if (shouldCallMkj) {
    mkjResult = await mkjSetMemberStatus(memberId, desiredAction);
  }

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
    casa: f.Casa,
    propietario: f.Propietario,
    mkjUserId: memberId,
    previousStatus,
    estado: desiredStatus,
    action: desiredAction,
    temporary,
    reason,
    mkjStatus: mkjResult ? mkjResult.status : 'sin-cambio',
    email,
    calc,
    owner: patched
  };
}

async function autoSyncAll(options = {}) {
  const ctx = await loadAccessContext();
  const results = [];
  for (const owner of ctx.owners.sort((a, b) => Number((a.fields || {}).Casa || 0) - Number((b.fields || {}).Casa || 0))) {
    try {
      results.push(await syncOwnerAccess(owner.id, options, ctx));
    } catch (error) {
      results.push({ ownerId: owner.id, casa: owner.fields?.Casa, propietario: owner.fields?.Propietario, error: error.message });
    }
  }
  return {
    success: true,
    total: results.length,
    limited: results.filter(r => r.estado === 'Limitado').length,
    enabled: results.filter(r => r.estado === 'Habilitado').length,
    skipped: results.filter(r => r.skipped || r.action === 'skip-exception').length,
    errors: results.filter(r => r.error).length,
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
  loadAccessContext,
  calculateExpiredAccessDebt,
  syncOwnerAccess,
  autoSyncAll,
  mkjLogin,
  mkjSetMemberStatus,
  TABLES
};