const { withAirtableUsage } = require('./_shared/_airtable_meter');
// netlify/functions/system-health.js
// Panel de salud protegido para revisar componentes críticos del sistema.
// Monitorea finanzas, Airtable, BCV, correo oficial, recibos, WhatsApp y control de acceso MKJoules.

const { requireAdmin } = require('./_shared/_auth');
const { calculateExpiredAccessDebt, getAccessMode, getAutomationRules } = require('./_shared/_access_control');
const { OFFICIAL_EMAIL } = require('./_shared/_mailer');
const { filterActiveExpenses, currentMonthCaracas } = require('./_shared/_expense_lifecycle');
const { connectLambdaEvent, getAtomicStore } = require('./_shared/_blobs_compat');
const { readOnlyAccessReconciliation } = require('./_shared/_access_reconciliation_readonly');
const crypto = require('crypto');
const EXPECTED_RELEASE = require('../../release.json');

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
function canonicalFinancialState(payload){
  const owners=Array.isArray(payload?.propietarios)?payload.propietarios:[],houses=owners.map(owner=>Number(owner?.Casa)).sort((a,b)=>a-b),expected=Array.from({length:15},(_,index)=>index+1);
  const invalid=owners.filter(owner=>{
    const usd=Number(owner?.saldoUsd),bs=Number(owner?.saldoBsRef),payable=Number(owner?.totalPagadero),net=Number(owner?.saldoNetoReferencial);
    return owner?.balanceEngineVersion!=='vla-balance-contract-v7'||![usd,bs,payable,net].every(Number.isFinite)||money(Math.max(0,usd)+Math.max(0,bs))!==money(payable)||money(usd+bs)!==money(net);
  }).map(owner=>Number(owner?.Casa)||'?');
  return{ok:owners.length===15&&JSON.stringify(houses)===JSON.stringify(expected)&&invalid.length===0,count:owners.length,invalid};
}
function intelligentProofAudit(records=[]){
  const digital=records.filter(record=>/^[a-f0-9]{64}$/i.test(String((record.fields||{})['Hash SHA-256']||'')));
  const pending=digital.filter(record=>selectName((record.fields||{}).Estado)==='Pendiente');
  const hasAnalysis=record=>hasValue((record.fields||{})['AI Analysis Completed At'])||Number((record.fields||{})['AI Confidence']||0)>0;
  const hasFailure=record=>hasValue((record.fields||{})['AI Failure Reason']);
  const analyzed=pending.filter(hasAnalysis),failed=pending.filter(hasFailure),waiting=pending.filter(record=>!hasAnalysis(record)&&!hasFailure(record));
  const historicalWithoutAnalysis=digital.filter(record=>selectName((record.fields||{}).Estado)!=='Pendiente'&&!hasAnalysis(record)&&!hasFailure(record));
  return{digital:digital.length,pending:pending.length,analyzed:analyzed.length,waiting:waiting.length,failed:failed.length,historicalWithoutAnalysis:historicalWithoutAnalysis.length};
}
function accessCoherenceState(mismatches=[],mode='Manual'){
  const automatic=mode==='Automático',requiresAction=automatic&&mismatches.length>0;
  return{ok:!requiresAction,severity:requiresAction?'error':'ok',automatic};
}
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
}
function releaseDigest(contract){return crypto.createHash('sha256').update(JSON.stringify(stable(contract))).digest('hex')}
function releaseContractState(expected,actual,deployment={}){
  const expectedKeys=Object.keys(expected||{}).sort(),actualKeys=Object.keys(actual||{}).sort(),fields=Array.from(new Set([...expectedKeys,...actualKeys])).sort();
  const differences=fields.filter(field=>!(field in (expected||{}))||!(field in (actual||{}))||JSON.stringify(stable(expected[field]))!==JSON.stringify(stable(actual[field])));
  const expectedDigest=releaseDigest(expected),actualDigest=releaseDigest(actual),manifestDigest=String(deployment?.releaseContractDigest||''),commit=String(deployment?.commit||'');
  const manifestOk=deployment?.schemaVersion==='vla-deployment-manifest-v1'&&deployment?.release===expected?.release&&manifestDigest===expectedDigest&&/^[a-f0-9]{40}$/i.test(commit);
  return{ok:differences.length===0&&manifestOk,differences,expectedDigest,actualDigest,manifestOk,commit,release:String(actual?.release||'')};
}

const handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const {
    AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, ADMIN_PASSWORD,
    SMTP_HOST, SMTP_USER, SMTP_SECRET, MAIL_FROM,
    MKJ_BASE_URL, MKJ_ORG_ID, MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD,
    GEMINI_API_KEY, PAYMENT_PROOF_ENCRYPTION_KEY, AUTOMATION_JOB_SECRET, ADMIN_TOKEN_SECRET, URL
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
    add('Credencial administrativa', true, 'La sesión firmada fue validada. La contraseña persistente se comprueba en la revisión avanzada sin exigir una variable obsoleta.');
    add('Airtable', isConfigured(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID), isConfigured(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID) ? `Base conectada: ${AIRTABLE_BASE_ID}` : 'Faltan AIRTABLE_API_TOKEN o AIRTABLE_BASE_ID.');
    add('Correo SMTP', smtpConfigured, smtpConfigured ? 'Variables SMTP configuradas.' : 'Faltan variables SMTP. Las notificaciones no saldrán.', smtpConfigured ? 'ok' : 'warning');
    add('Remitente oficial', officialSender, officialSender ? `Bloqueado correctamente a ${OFFICIAL_EMAIL}.` : `El sistema solo debe enviar desde ${OFFICIAL_EMAIL}. Revise SMTP_USER o MAIL_FROM en Netlify.`, officialSender ? 'ok' : 'error');
    add('Variables MKJoules', isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID), isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID) ? `Configurado para org ${MKJ_ORG_ID}.` : 'Faltan variables MKJ. El portón no podrá sincronizarse.', isConfigured(MKJ_ADMIN_EMAIL, MKJ_ADMIN_PASSWORD, MKJ_ORG_ID) ? 'ok' : 'error');
    add('URL MKJoules', true, MKJ_BASE_URL || 'Usando valor por defecto: https://cloud.mkjoules.com');
    add('Analizador inteligente de pagos', !!GEMINI_API_KEY, GEMINI_API_KEY ? 'Proveedor configurado; la clave permanece oculta.' : 'Falta GEMINI_API_KEY. Los comprobantes pasarán a revisión manual.', GEMINI_API_KEY ? 'ok' : 'warning');
    let proofEncryptionOk=false;try{require('./_shared/_payment_proof_store').resolveEncryptionKey(process.env);proofEncryptionOk=true}catch(_){proofEncryptionOk=false}
    add('Cifrado de comprobantes', proofEncryptionOk, proofEncryptionOk ? 'AES-256-GCM listo para comprobantes.' : 'Configure una clave de 32 bytes o un secreto interno fuerte antes de activar autopago.', proofEncryptionOk ? 'ok' : 'warning');
    const internalJobsReady=isConfigured(AUTOMATION_JOB_SECRET||ADMIN_TOKEN_SECRET||ADMIN_PASSWORD,URL);
    add('Trabajos automáticos internos',internalJobsReady,internalJobsReady?'Cola asíncrona autenticada y URL de producción disponibles.':'Falta URL o secreto para autenticar la cola asíncrona.',internalJobsReady?'ok':'warning');
    try {
      const connection=connectLambdaEvent(event);
      await getAtomicStore('vla-system-health-v1').getWithMetadata('runtime-readiness-probe',{type:'json'});
      add('Almacenamiento seguro Netlify',true,`Contexto Blobs operativo mediante ${connection.source}; lectura protegida disponible.`);
    } catch (error) {
      add('Almacenamiento seguro Netlify',false,`El runtime no pudo abrir Blobs: ${String(error.code||error.message||'error desconocido').slice(0,240)}`,'error');
    }

    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ ok: false, status: 'error', checks, generatedAt: new Date().toISOString(), apiUsage: counter }) };
    }

    const [propietarios, gastos, pagos, reportes, recibos, whatsappJobs, whatsappSchedules] = await Promise.all([
      getAll(TABLES.propietarios, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario', 'Casa', 'Email', 'Deuda Anterior', 'Deuda Anterior USD', 'Deuda Anterior Bs Ref', 'Deuda Restante', 'MKJ User ID', 'MKJ Email', 'Estado Acceso Portón', 'Excepción Acceso', 'Última Sync MKJ', 'Motivo Limitación Acceso']),
      getAll(TABLES.gastos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Concepto', 'Monto', 'Tipo de Gasto', 'Forma de Pago', 'Propietarios','Mes de Aplicación','Estado del Gasto']),
      getAll(TABLES.pagos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario que Paga', 'Forma de Pago', 'Monto Pagado', 'Equivalente USD Aplicado', '[x] Aplicado al Cierre']),
      getAll(TABLES.reportes, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Propietario que Reporta', 'Estado', 'Forma de Pago Reportada', 'Monto Reportado', 'Equivalente USD Reportado','Hash SHA-256','AI Confidence','AI Analysis Completed At','AI Failure Reason','Estado de Procesamiento']),
      getAll(TABLES.recibos, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Nro Recibo', 'Fecha', 'Estado Email', 'Correo', 'Log', 'Enviado En']),
      getAll(TABLES.whatsappJobs, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Job ID', 'Estado', 'Creado En', 'Finalizado En', 'Enviados', 'Simulados', 'Errores', 'Log']),
      getAll(TABLES.whatsappSchedules, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter, ['Nombre', 'Activo', 'Hora', 'Día del Mes', 'Modo', 'Última Ejecución', 'Último Job ID'])
    ]);

    add('Tablas principales Airtable', true, `Propietarios: ${propietarios.length}; Gastos: ${gastos.length}; Pagos: ${pagos.length}; Reportes: ${reportes.length}; Recibos: ${recibos.length}.`);

    const activeExpenses=filterActiveExpenses(gastos,currentMonthCaracas());
    const totalLegacyCount=gastos.filter(g=>String((g.fields||{}).Concepto||'').toLowerCase().includes('(cargo individual)')).length;
    const activeLegacyCount=activeExpenses.filter(g=>String((g.fields||{}).Concepto||'').toLowerCase().includes('(cargo individual)')).length;
    const historicalLegacyCount=Math.max(0,totalLegacyCount-activeLegacyCount);
    add('Modo contable',activeLegacyCount===0,activeLegacyCount>0
      ?`Transición activa: ${activeLegacyCount} cargo(s) individual(es) legacy vigentes en el mes operativo. Históricos excluidos: ${historicalLegacyCount}.`
      :historicalLegacyCount>0
        ?`Modo doble moneda limpio. ${historicalLegacyCount} cargo(s) individual(es) legacy están cerrados como histórico y no participan en el cálculo actual.`
        :'Modo doble moneda limpio.',activeLegacyCount>0?'warning':'ok',{activeLegacyCount,historicalLegacyCount,source:'active-expense-lifecycle'});

    const unclassified = gastos.filter(g => !((g.fields || {})['Forma de Pago'])).length;
    add('Gastos con forma de pago', unclassified === 0, unclassified ? `${unclassified} gasto(s) sin Forma de Pago.` : 'Todos clasificados.', unclassified ? 'warning' : 'ok');

    let accessModeInfo,automationInfo;
    try {
      accessModeInfo = await getAccessMode();
      automationInfo=await getAutomationRules(accessModeInfo);
      counter.airtable += 1;
      add('Modo Control Portón', true, accessModeInfo.mode === 'Automático' ? 'Automático activo.' : 'Manual activo por decisión administrativa: las sincronizaciones automáticas permanecen pausadas.', 'ok', {mode:accessModeInfo.mode});
    } catch (error) {
      add('Modo Control Portón', false, error.message);
    }

    const missingMkj = countMissing(propietarios, 'MKJ User ID');
    add('MKJ User ID por propietario', missingMkj === 0, missingMkj ? `${missingMkj}/${propietarios.length} propietario(s) sin MKJ User ID.` : `Todos los propietarios tienen MKJ User ID.`, missingMkj ? 'warning' : 'ok');

    const missingOwnerEmail = propietarios.filter(r => !hasValue((r.fields || {}).Email) && !hasValue((r.fields || {})['MKJ Email'])).length;
    add('Correos para notificaciones de portón', missingOwnerEmail === 0, missingOwnerEmail ? `${missingOwnerEmail} propietario(s) sin correo disponible.` : 'Todos tienen Email o MKJ Email.', missingOwnerEmail ? 'warning' : 'ok');

    const status = statusCount(propietarios, 'Estado Acceso Portón');
    add('Estados de acceso portón', true, `Habilitado: ${status.Habilitado || 0}; Limitado: ${status.Limitado || 0}; Excepción: ${status['Excepción Manual'] || 0}; Error: ${status['Error Sync'] || 0}; Sin configurar: ${status['Sin configurar'] || 0}.`, status['Error Sync'] ? 'warning' : 'ok', status);

    const rules=automationInfo?.rules;
    const expired = propietarios.map(owner => ({ owner, calc: calculateExpiredAccessDebt(owner, pagos, reportes, {expenses:activeExpenses,dueDay:rules?.payment?.dueDay||10,surchargeRate:rules?.payment?.surchargeRate??0.10}) }));
    const withExpiredDebt = expired.filter(x => x.calc.hasExpiredDebt).length;
    const pendingCovered = expired.filter(x => x.calc.hasExpiredDebt && x.calc.pendingCoversExpiredDebt).length;
    const totalExpired = money(expired.reduce((sum, x) => sum + x.calc.expiredTotal, 0));
    add('Deuda vencida para control de acceso', true, `Dato operativo: ${withExpiredDebt} propietario(s) con deuda vencida; total ref. $${totalExpired.toFixed(2)}; reportes pendientes suficientes: ${pendingCovered}. La morosidad no representa una falla técnica.`, 'ok', {owners:withExpiredDebt,totalExpired,pendingCovered});

    const accessMismatches = expired.filter(({owner,calc}) => {
      const fields=owner.fields||{},actual=selectName(fields['Estado Acceso Portón']);
      if(fields['Excepción Acceso']===true)return actual!=='Excepción Manual';
      return actual!==(calc.hasExpiredDebt?'Limitado':'Habilitado');
    }).map(({owner,calc})=>({
      casa:(owner.fields||{}).Casa,
      propietario:(owner.fields||{}).Propietario,
      actual:selectName((owner.fields||{})['Estado Acceso Portón']),
      esperado:(owner.fields||{})['Excepción Acceso']===true?'Excepción Manual':(calc.hasExpiredDebt?'Limitado':'Habilitado')
    }));
    const coherence=accessCoherenceState(accessMismatches,accessModeInfo?.mode);
    add('Coherencia financiera del portón',coherence.ok,accessMismatches.length
      ?`${coherence.automatic?'Requiere sincronización automática':'Modo Manual: diferencia informativa, bajo control administrativo'}. ${accessMismatches.length} acceso(s): ${accessMismatches.map(item=>`Casa ${item.casa} (${item.actual} → ${item.esperado})`).join(', ')}.`
      :'Todos los estados de acceso coinciden con la deuda vencida o con una excepción auditada.',coherence.severity,{mismatches:accessMismatches,mode:accessModeInfo?.mode});

    try {
      counter.external += 3;
      const expiredByOwnerId=new Map(expired.map(item=>[item.owner.id,item.calc.hasExpiredDebt])),reconciliation=await readOnlyAccessReconciliation(propietarios,expiredByOwnerId,{mode:accessModeInfo?.mode||'Manual'}),reconciliationOk=reconciliation.total===15&&reconciliation.coherent===15;
      add('Conciliación MKJ 15/15 (solo lectura)',reconciliationOk,`Comparadas ${reconciliation.total}/15 casas; coherentes ${reconciliation.coherent}/15; diferencias ${reconciliation.mismatches.length}. No se ejecutó ninguna escritura en Airtable ni cambio de acceso en MKJ.`,reconciliationOk?'ok':accessModeInfo?.mode==='Automático'?'error':'warning',{readOnly:true,total:reconciliation.total,coherent:reconciliation.coherent,mismatches:reconciliation.mismatches});
    } catch (error) {
      add('Conciliación MKJ 15/15 (solo lectura)',false,`La lectura comparativa no pudo completarse: ${String(error.message||error).slice(0,300)}. No se intentó ninguna escritura.`,accessModeInfo?.mode==='Automático'?'error':'warning',{readOnly:true});
    }

    const pendingReports = reportes.filter(r => selectName((r.fields || {}).Estado) === 'Pendiente').length;
    add('Reportes pendientes y portón', true, pendingReports ? `${pendingReports} reporte(s) pendiente(s). Un reporte no altera deuda ni acceso hasta quedar validado.` : 'No hay reportes pendientes.', pendingReports ? 'warning' : 'ok');

    const proofAudit=intelligentProofAudit(reportes);
    add('Auditoría inteligente de comprobantes',proofAudit.waiting===0&&proofAudit.failed===0,`Comprobantes cifrados: ${proofAudit.digital}; pendientes administrativos: ${proofAudit.pending}; análisis activos con evidencia: ${proofAudit.analyzed}; pendientes de análisis profundo activos: ${proofAudit.waiting}; fallidos activos: ${proofAudit.failed}; históricos cerrados sin análisis profundo: ${proofAudit.historicalWithoutAnalysis}.`,proofAudit.failed?'error':proofAudit.waiting?'warning':'ok',proofAudit);

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
    const whatsappSafe=activeSchedules===0&&pendingJobs===0&&errorJobs===0;
    add('WhatsApp opcional', whatsappSafe, whatsappSafe
      ? 'Sin programaciones reales activas ni jobs pendientes. Los avisos críticos siguen por correo automático; WhatsApp queda disponible solo como conector manual.'
      : `Requiere atención: programaciones activas ${activeSchedules}; jobs pendientes ${pendingJobs}; jobs con errores ${errorJobs}; último job ${lastJob ? ((lastJob.fields || {})['Job ID'] || 'sin ID') : 'ninguno'}. El envío real depende de un agente local y no debe considerarse autónomo.`,
      whatsappSafe?'ok':'warning');

    add('Botón Portón en admin', true, 'Disponible en el panel Admin como 🚪 Portón; abre el selector Automático/Manual, Auto Sync y botones Habilitar/Limitar.');
    add('Botón Auto Sync', true, 'Disponible dentro del módulo Portón. En modo Manual queda bloqueado para evitar ejecuciones accidentales.');
    add('Prueba login MKJ', true, 'La conciliación protegida verifica sesión y membresías únicamente mediante GET; no habilita ni limita usuarios.', 'ok');

    try {
      counter.external += 1;
      const bcv = await fetch(`${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}/.netlify/functions/bcv-rate?force=1`).then(r => r.json());
      add('Tasa BCV', !!bcv.rate, bcv.rate ? `${bcv.rateFormatted || String(bcv.rate)} · fuente: ${bcv.source || 'N/A'}` : 'No disponible.', bcv.rate ? 'ok' : 'warning');
    } catch (error) {
      add('Tasa BCV', false, error.message, 'warning');
    }

    try {
      counter.external += 1;
      const origin=`${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}`,publicResponse=await fetch(`${origin}/api/vla/public-data`),publicPayload=await publicResponse.json(),financial=canonicalFinancialState(publicPayload),snapshot=String(publicResponse.headers.get('x-public-snapshot')||'DIRECT');
      add('Contabilidad canónica',financial.ok,financial.ok?'Contrato v7 consistente: total pagadero separa USD y Bs en las 15 casas.':`Contrato financiero incompleto o inconsistente en: ${financial.invalid.length?financial.invalid.map(casa=>`Casa ${casa}`).join(', '):'respuesta pública'}.`,financial.ok?'ok':'error',{invalidHouses:financial.invalid});
      add('Casas financieras 15/15',financial.count===15,`${financial.count}/15 casas recibidas desde la fuente pública oficial.`,financial.count===15?'ok':'error');
      const snapshotOk=publicResponse.ok&&!['ERROR','REFRESH_BUSY','STALE','STALE_FALLBACK','STALE_EXCEPTION','BLOB_UNAVAILABLE','WRITE_WARNING'].includes(snapshot);
      add('Snapshot público',snapshotOk,`Estado: ${snapshot}.`,snapshotOk?'ok':'warning',{state:snapshot});
    } catch (error) {
      add('Contabilidad canónica',false,`No se pudo contrastar el contrato público: ${error.message}`,'error');
      add('Casas financieras 15/15',false,'No fue posible verificar el conjunto público de casas.','error');
      add('Snapshot público',false,'No fue posible leer el estado del snapshot.','warning');
    }

    try {
      counter.external += 2;
      const origin=`${event.headers['x-forwarded-proto'] || 'https'}://${event.headers.host}`;
      const [releaseResponse,deploymentResponse]=await Promise.all([fetch(`${origin}/release.json?health=${Date.now()}`,{headers:{'Cache-Control':'no-cache'}}),fetch(`${origin}/deployment.json?health=${Date.now()}`,{headers:{'Cache-Control':'no-cache'}})]);
      if(!releaseResponse.ok||!deploymentResponse.ok)throw new Error(`HTTP release ${releaseResponse.status}; deployment ${deploymentResponse.status}`);
      const [liveRelease,deployment]=await Promise.all([releaseResponse.json(),deploymentResponse.json()]),state=releaseContractState(EXPECTED_RELEASE,liveRelease,deployment);
      add('Deployment y release',state.ok,state.ok
        ?`Release ${state.release}; contrato ${state.expectedDigest.slice(0,12)}; commit ${state.commit.slice(0,12)} verificados contra el código desplegado.`
        :`Release/commit no coinciden con el contrato del código. Campos distintos: ${state.differences.join(', ')||'manifiesto de deployment'}.`,state.ok?'ok':'error',{release:state.release,commit:state.commit,contractDigest:state.expectedDigest,differences:state.differences,manifestOk:state.manifestOk});
    } catch (error) {
      add('Deployment y release',false,`No fue posible verificar release y commit desplegados: ${error.message}`,'error');
    }

    const closeRules=automationInfo?.rules?.monthlyClose;
    add('Cierre mensual',Boolean(closeRules),closeRules?`Configurado para el día ${closeRules.day} a las ${String(closeRules.hour).padStart(2,'0')}:00, con recuperación los días ${(closeRules.retryDays||[]).join(', ')}. Modo automático: ${closeRules.automaticEnabled?'activo':'pausado'}.`:'No fue posible cargar las reglas de cierre.',closeRules?'ok':'error');

    add('Uso de API en Salud', true, `Lectura ampliada: ${counter.airtable} llamada(s) a Airtable y ${counter.external} llamada(s) externa(s). La verificación MKJ es estrictamente de solo lectura.`);

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

exports.handler = withAirtableUsage('system-health', handler);
exports.intelligentProofAudit=intelligentProofAudit;
exports.accessCoherenceState=accessCoherenceState;
exports.canonicalFinancialState = canonicalFinancialState;
exports.releaseContractState = releaseContractState;
