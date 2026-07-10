// netlify/functions/system-health.js
// Panel de salud protegido para revisar componentes críticos del sistema.
// Monitorea finanzas, Airtable, BCV, correo oficial, recibos, WhatsApp y control de acceso MKJoules.

const { requireAdmin } = require('./_auth');
const { calculateExpiredAccessDebt, getAccessMode } = require('./_access_control');
const { OFFICIAL_EMAIL } = require('./_mailer');

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  reportes: 'Reportes de Pago',
  recibos: 'Recibos de Pago',
  whatsappJobs: 'WhatsApp Jobs',
  whatsappSchedules: 'WhatsApp Programaciones',
  config: 'Configuración'
};

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

function fieldsQuery(fields) {
  const params = new URLSearchParams();
  (fields || []).forEach(f => params.append('fields[]', f));
  return params.toString() ? '?' + params.toString() : '';
}

async function getAll(tableName, token, baseId, counter, fields = [], extraQuery = '') {
  let records = [];
  let offset = null;
  const baseQuery = fieldsQuery(fields);
  const fixedExtra = extraQuery ? (extraQuery.startsWith('?') ? extraQuery.slice(1) : extraQuery) : '';
  do {
    const params = [];
    if (baseQuery) params.push(baseQuery.slice(1));
    if (fixedExtra) params.push(fixedExtra);
    if (offset) params.push(`offset=${encodeURIComponent(offset)}`);
    const url = buildUrl(baseId, tableName, params.length ? `?${params.join('&')}` : '');
    counter.airtable += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error en ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

function money(n) { return Math.round(Number(n || 0) * 100) / 100; }
function hasValue(v) { return String(v || '').trim().length > 0; }
function normalizeEmail(value = '') {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim();
}
function selectName(value) { return value && typeof value === 'object' && value.name ? value.name : String(value || ''); }
function statusCount(records, field) {
  return records.reduce((acc, r) => {
    const value = selectName((r.fields || {})[field] || 'Sin configurar');
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}
function countMissing(records, field) {
  return records.filter(r => !hasValue((r.fields || {})[field])).length;
}
function isConfigured(...values) {
  return values.every(v => hasValue(v));
}
function latestByField(records, field) {
  return [...records].sort((a, b) => String((b.fields || {})[field] || '').localeCompare(String((a.fields || {})[field] || '')))[0] || null;
}
function newestRecords(records, limit = 20) {
  return [...records]
    .sort((a, b) => String(b.createdTime || (b.fields || {})['Enviado En'] || (b.fields || {}).Fecha || '').localeCompare(String(a.createdTime || (a.fields || {})['Enviado En'] || (a.fields || {}).Fecha || '')))
    .slice(0, limit);
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const {
    AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, ADMIN_PASSWORD,
    SMTP_HOST, SMTP_USER, SMTP_SECRET, MAIL_FROM,
    MKJ_BASE_URL, MKJ_ORG_ID, MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD
  } = process.env;

  const checks = [];
  const counter = { airtable: 0, external: 0 };

  function add(name, ok, detail, severity = ok ? 'ok' : 'error', meta = undefined) {
    checks.push({ name, ok, detail, severity, ...(meta ? { meta } : {}) });
  }

  try {
    const smtpConfigured = isConfigured(SMTP_HOST, SMTP_USER, SMTP_SECRET);
    const officialSender = smtpConfigured && (normalizeEmail(SMTP_USER) === OFFICIAL_EMAIL || normalizeEmail(MAIL_FROM) === OFFICIAL_EMAIL);

    add('Token administrativo', true, 'Sesión administrativa válida.');
    add('ADMIN_PASSWORD', !!ADMIN_PASSWORD, ADMIN_PASSWORD ? 'Configurada.' : 'No configurada.');
    add('Airtable', isConfigured(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID), isConfigured(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID) ? `Base conectada: ${AIRTABLE_BASE_ID}` : 'Faltan AIRTABLE_API_TOKEN o AIRTABLE_BASE_ID.');
    add('Correo SMTP', smtpConfigured, smtpConfigured ? 'Variables SMTP configuradas.' : 'Faltan variables SMTP. Las notificaciones no saldrán.', smtpConfigured ? 'ok' : 'warning');
    add('Remitente oficial', officialSender, officialSender ? `Bloqueado correctamente a ${OFFICIAL_EMAIL}.` : `El sistema solo debe enviar desde ${OFFICIAL_EMAIL}. Revise SMTP_USER o MAIL_FROM en Netlify.`, officialSender ? 'ok' : 'error');
    add('Variables MKJoules', isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID), isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID) ? `Configurado para org ${MKJ_ORG_ID}.` : 'Faltan variables MKJ. El portón no podrá sincronizarse.', isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID) ? 'ok' : 'error');
    add('URL MKJoules', true, MKJ_BASE_URL || 'Usando valor por defecto: https://cloud.mkjoules.com');

    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, status: 'error', checks, generatedAt: new Date().toISOString(), apiUsage: counter }) };
    }

    const [propietarios, gastos, pagos, reportes, recibos, whatsappJobs, whatsappSchedules] = await Promise.all([
      getAll(TABLES.propietarios, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario', 'Casa', 'Email', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Anterior Bs Ref', 'Deuda Restante', 'MKJ User ID', 'MKJ Email', 'Estado Acceso Portón', 'Excepción Acceso', 'Última Sync MKJ', 'Motivo Limitación Acceso']),
      getAll(TABLES.gastos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Concepto', 'Monto', 'Tipo de Gasto', 'Forma de Pago', 'Propietarios']),
      getAll(TABLES.pagos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario que Paga', 'Forma de Pago', 'Monto Pagado', 'Equivalente USD Aplicado', '[x] Aplicado al Cierre']),
      getAll(TABLES.reportes, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario que Reporta', 'Estado', 'Forma de Pago Reportada', 'Monto Reportado', 'Equivalente USD Reportado']),
      getAll(TABLES.recibos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Nro Recibo', 'Fecha', 'Estado Email', 'Correo', 'Log', 'Enviado En']),
      getAll(TABLES.whatsappJobs, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Job ID', 'Estado', 'Creado En', 'Finalizado En', 'Enviados', 'Simulados', 'Errores', 'Log']),
      getAll(TABLES.whatsappSchedules, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Nombre', 'Activo', 'Hora', 'Día del Mes', 'Modo', 'Última Ejecución', 'Último Job ID'])
    ]);

    add('Tablas principales Airtable', true, `Propietarios: ${propietarios.length}; Gastos: ${gastos.length}; Pagos: ${pagos.length}; Reportes: ${reportes.length}; Recibos: ${recibos.length}.`);

    const legacyCount = gastos.filter(g => String((g.fields || {}).Concepto || '').toLowerCase().includes('(cargo individual)')).length;
    add('Modo contable', true, legacyCount > 0 ? `Transición activa: ${legacyCount} cargo(s) individual(es) legacy.` : 'Modo doble moneda limpio.', legacyCount > 0 ? 'warning' : 'ok');

    const unclassified = gastos.filter(g => !((g.fields || {})['Forma de Pago'])).length;
    add('Gastos con forma de pago', unclassified === 0, unclassified ? `${unclassified} gasto(s) sin Forma de Pago.` : 'Todos clasificados.', unclassified ? 'warning' : 'ok');

    let accessModeInfo;
    try {
      accessModeInfo = await getAccessMode();
      counter.airtable += 1;
      add('Modo Control Portón', true, accessModeInfo.mode === 'Automático' ? 'Automático activo.' : 'Manual activo: las sincronizaciones automáticas están pausadas.', accessModeInfo.mode === 'Automático' ? 'ok' : 'warning');
    } catch (error) {
      add('Modo Control Portón', false, error.message);
    }

    const missingMkj = countMissing(propietarios, 'MKJ User ID');
    add('MKJ User ID por propietario', missingMkj === 0, missingMkj ? `${missingMkj}/${propietarios.length} propietario(s) sin MKJ User ID.` : `Todos los propietarios tienen MKJ User ID.`, missingMkj ? 'warning' : 'ok');

    const missingOwnerEmail = propietarios.filter(r => !hasValue((r.fields || {}).Email) && !hasValue((r.fields || {})['MKJ Email'])).length;
    add('Correos para notificaciones de portón', missingOwnerEmail === 0, missingOwnerEmail ? `${missingOwnerEmail} propietario(s) sin correo disponible.` : 'Todos tienen Email o MKJ Email.', missingOwnerEmail ? 'warning' : 'ok');

    const status = statusCount(propietarios, 'Estado Acceso Portón');
    add('Estados de acceso portón', true, `Habilitado: ${status.Habilitado || 0}; Limitado: ${status.Limitado || 0}; Excepción: ${status['Excepción Manual'] || 0}; Error: ${status['Error Sync'] || 0}; Sin configurar: ${status['Sin configurar'] || 0}.`, status['Error Sync'] ? 'warning' : 'ok', status);

    const expired = propietarios.map(owner => ({ owner, calc: calculateExpiredAccessDebt(owner, pagos, reportes) }));
    const withExpiredDebt = expired.filter(x => x.calc.hasExpiredDebt).length;
    const pendingCovered = expired.filter(x => x.calc.hasExpiredDebt && x.calc.pendingCoversExpiredDebt).length;
    const totalExpired = money(expired.reduce((sum, x) => sum + x.calc.expiredTotal, 0));
    add('Deuda vencida para control de acceso', true, `Propietarios con deuda vencida: ${withExpiredDebt}. Total vencido ref.: $${totalExpired.toFixed(2)}. Reportes pendientes suficientes: ${pendingCovered}.`, withExpiredDebt ? 'warning' : 'ok');

    const pendingReports = reportes.filter(r => selectName((r.fields || {}).Estado) === 'Pendiente').length;
    add('Reportes pendientes y portón', true, pendingReports ? `${pendingReports} reporte(s) pendiente(s). El sistema habilita temporalmente solo si cubren toda la deuda vencida.` : 'No hay reportes pendientes.', pendingReports ? 'warning' : 'ok');

    const receiptErrors = recibos.filter(r => {
      const status = selectName((r.fields || {})['Estado Email']);
      return status && status !== 'Enviado';
    });
    const recentReceipts = newestRecords(recibos, 20);
    const sentRecentReceipts = recentReceipts.filter(r => selectName((r.fields || {})['Estado Email']) === 'Enviado');
    const legacyReceiptAudit = sentRecentReceipts.filter(r => {
      const log = String((r.fields || {}).Log || '');
      return log && !log.includes('PDF generado') && !log.includes('PDF adjuntado');
    }).length;
    const suspiciousPdfAudit = sentRecentReceipts.filter(r => {
      const log = String((r.fields || {}).Log || '');
      return log.includes('PDF generado') && !log.includes('PDF adjuntado');
    }).length;
    const lastReceipt = latestByField(recibos, 'Enviado En') || latestByField(recibos, 'Fecha');
    const receiptOk = receiptErrors.length === 0 && suspiciousPdfAudit === 0;
    const receiptDetail = receiptErrors.length
      ? `${receiptErrors.length} recibo(s) con error de email/PDF.`
      : suspiciousPdfAudit
        ? `${suspiciousPdfAudit} recibo(s) nuevos generaron PDF pero no registran adjunto.`
        : legacyReceiptAudit
          ? `Sin errores detectados. ${legacyReceiptAudit} recibo(s) enviados recientes son anteriores a la auditoría nueva de PDF adjunto.`
          : 'Recibos recientes con auditoría de correo/PDF correcta.';
    add('Recibos y PDF por correo', receiptOk, receiptDetail, receiptErrors.length ? 'error' : suspiciousPdfAudit ? 'warning' : 'ok', { ultimo: lastReceipt ? (lastReceipt.fields || {})['Nro Recibo'] : null, legacyAuditCount: legacyReceiptAudit });

    const activeSchedules = whatsappSchedules.filter(r => !!(r.fields || {}).Activo).length;
    const pendingJobs = whatsappJobs.filter(r => selectName((r.fields || {}).Estado) === 'Pendiente').length;
    const errorJobs = whatsappJobs.filter(r => Number((r.fields || {}).Errores || 0) > 0 || selectName((r.fields || {}).Estado) === 'Error').length;
    const lastJob = latestByField(whatsappJobs, 'Creado En') || latestByField(whatsappJobs, 'Finalizado En');
    add('WhatsApp local agent', true, `Programaciones activas: ${activeSchedules}; Jobs pendientes: ${pendingJobs}; Jobs con errores: ${errorJobs}; Último job: ${lastJob ? ((lastJob.fields || {})['Job ID'] || 'sin ID') : 'ninguno'}.`, pendingJobs || errorJobs ? 'warning' : 'ok');

    add('Botón Portón en admin', true, 'Disponible en el panel Admin como 🚪 Portón; abre el selector Automático/Manual, Auto Sync y botones Habilitar/Limitar.');
    add('Botón Auto Sync', true, 'Disponible dentro del módulo Portón. En modo Manual queda bloqueado para evitar ejecuciones accidentales.');
    add('Prueba login MKJ', true, 'Disponible como botón manual. Salud no ejecuta login MKJ para evitar llamadas externas innecesarias.', 'ok');

    try {
      counter.external += 1;
      const bcv = await fetch(`${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}/.netlify/functions/bcv-rate?force=1`).then(r => r.json());
      add('Tasa BCV', !!bcv.rate, bcv.rate ? `${bcv.rateFormatted || String(bcv.rate)} · fuente: ${bcv.source || 'N/A'}` : 'No disponible.', bcv.rate ? 'ok' : 'warning');
    } catch (error) {
      add('Tasa BCV', false, error.message, 'warning');
    }

    add('Uso de API en Salud', true, `Lectura ampliada: ${counter.airtable} llamada(s) a Airtable y ${counter.external} llamada(s) externa(s). No se prueba login MKJ automáticamente.`);

    const hasError = checks.some(c => c.severity === 'error');
    const hasWarning = checks.some(c => c.severity === 'warning');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: !hasError, status: hasError ? 'error' : hasWarning ? 'warning' : 'ok', checks, generatedAt: new Date().toISOString(), apiUsage: counter })
    };
  } catch (error) {
    add('Error general', false, error.message);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, status: 'error', checks, generatedAt: new Date().toISOString(), apiUsage: counter }) };
  }
};