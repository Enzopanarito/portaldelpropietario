'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const publicData = require('./public-data-v3');
const { getAll, TABLES } = require('./_shared/_monthly_close_store');
const { buildPunctualityScore } = require('./_shared/_punctuality_score');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function json(statusCode, body, counter = null, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Punctuality-Read-Only': 'true',
      ...(counter ? { 'X-Airtable-Calls': String(counter.calls || 0) } : {}),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}
function parseBody(result) {
  try { return JSON.parse(result && result.body || '{}'); }
  catch (_) { return {}; }
}
function previewMode(env = process.env) {
  const context = String(env.CONTEXT || '').trim().toLowerCase();
  const dataEnvironment = String(env.VLA_DATA_ENVIRONMENT || '').trim().toLowerCase();
  // Un Deploy Preview/branch/dev explícito jamás debe consultar producción,
  // aunque herede por accidente VLA_DATA_ENVIRONMENT=production del sitio.
  if (['deploy-preview', 'branch-deploy', 'dev'].includes(context)) return true;
  // Producción real mantiene prioridad cuando CONTEXT la identifica.
  if (context === 'production') return false;
  // Los deploys CLI de producción pueden no traer CONTEXT; en ese caso la
  // variable de datos conserva el fail-safe hacia el historial real.
  if (dataEnvironment === 'production') return false;
  if (['staging', 'local', 'preview', 'test'].includes(dataEnvironment)) return true;
  // Un entorno desconocido nunca recibe fixture ficticio.
  return false;
}
function previewScore(ownerId, now = new Date()) {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit' }).format(now);
  function previous(value, delta) {
    const [y, m] = value.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return {
    version: 'vla-punctuality-v2', readOnly: true, preview: true, ownerId: String(ownerId || ''), casa: 4,
    score: 78, level: { key: 'ACEPTABLE', label: 'Aceptable', color: '#e8ba25' }, evaluatedMonths: 6,
    targetMonths: 12, forming: false, onTimeMonths: 3, onTimeRate: 50, severityScore: 86,
    streak: 1, trend: { key: 'SUBIENDO', label: 'Subiendo', symbol: '↑' }, dueDay: 10,
    history: [
      { month, score: 100, state: 'PUNTUAL', finalized: true, completionDate: `${month}-08`, completionDay: 8, source: 'PREVIEW' },
      { month: previous(month, -1), score: 80, state: 'LEVE_RETRASO', finalized: true, completionDate: `${previous(month, -1)}-13`, completionDay: 13, source: 'PREVIEW' },
      { month: previous(month, -2), score: 100, state: 'PUNTUAL', finalized: true, completionDate: `${previous(month, -2)}-07`, completionDay: 7, source: 'PREVIEW' },
      { month: previous(month, -3), score: 60, state: 'RETRASO', finalized: true, completionDate: `${previous(month, -3)}-18`, completionDay: 18, source: 'PREVIEW' },
      { month: previous(month, -4), score: 100, state: 'PUNTUAL', finalized: true, completionDate: `${previous(month, -4)}-09`, completionDay: 9, source: 'PREVIEW' },
      { month: previous(month, -5), score: 40, state: 'TARDIO', finalized: true, completionDate: `${previous(month, -5)}-24`, completionDay: 24, source: 'PREVIEW' }
    ],
    advice: 'Los meses puntuales pesan mucho. Mantén todos tus pagos definitivos dentro de los primeros 10 días.',
    generatedAt: new Date().toISOString()
  };
}
function sanitizedScore(score) {
  if (!score || typeof score !== 'object') return score;
  return {
    version: score.version,
    readOnly: true,
    ownerId: score.ownerId,
    casa: score.casa,
    score: score.score,
    level: score.level,
    evaluatedMonths: score.evaluatedMonths,
    targetMonths: score.targetMonths,
    forming: score.forming,
    onTimeMonths: score.onTimeMonths,
    onTimeRate: score.onTimeRate,
    severityScore: score.severityScore,
    streak: score.streak,
    trend: score.trend,
    dueDay: score.dueDay,
    history: (score.history || []).map(item => ({
      month: item.month,
      score: item.score,
      state: item.state,
      finalized: item.finalized,
      completionDate: item.completionDate || null,
      completionDay: item.completionDay || null,
      paymentCount: item.paymentCount || 0,
      remainingReference: item.remainingReference,
      source: item.source
    })),
    advice: score.advice,
    generatedAt: score.generatedAt
  };
}

function createHandler(deps = {}) {
  const publicHandler = deps.publicHandler || publicData.handler;
  const listAll = deps.getAll || getAll;
  const scoreBuilder = deps.buildPunctualityScore || buildPunctualityScore;
  const isPreview = deps.previewMode || previewMode;
  const now = deps.now || (() => new Date());
  const env = deps.env || process.env;
  const scoreCache = deps.cache || cache;
  return async function handler(event) {
    if (event.httpMethod && event.httpMethod !== 'GET') return json(405, { message: 'Method Not Allowed' });
    const ownerId = String(event.queryStringParameters && event.queryStringParameters.ownerId || '').trim();
    if (!/^rec[A-Za-z0-9]{14}$/.test(ownerId) && !isPreview(env)) return json(400, { message: 'Propietario inválido.' });
    if (!ownerId) return json(400, { message: 'Debe indicar el propietario.' });

    if (isPreview(env)) return json(200, previewScore(ownerId, now()), null, { 'X-Punctuality-Source': 'PREVIEW_FIXTURE' });

    const cached = scoreCache.get(ownerId);
    if (cached && cached.expiresAt > Date.now()) return json(200, cached.value, null, { 'X-Punctuality-Source': 'MEMORY_CACHE' });

    const token = env.AIRTABLE_API_TOKEN, baseId = env.AIRTABLE_BASE_ID;
    if (!token || !baseId) return json(503, { message: 'Índice temporalmente no disponible.' });
    const counter = { calls: 0 };
    try {
      const publicResultPromise = publicHandler({
        ...event,
        httpMethod: 'GET',
        queryStringParameters: { ...(event.queryStringParameters || {}), force: '1' }
      });
      const auditFormula = encodeURIComponent("LEFT({Concepto},10)='AUDITORIA|'");
      const [publicResult, history] = await Promise.all([
        publicResultPromise,
        listAll(TABLES.history, `?filterByFormula=${auditFormula}`, token, baseId, counter)
      ]);
      const payload = parseBody(publicResult);
      if (Number(publicResult.statusCode) !== 200) throw new Error(payload.message || 'No se pudo leer el libro contable público.');
      const owner = (payload.propietarios || []).find(item => String(item.id) === ownerId);
      if (!owner) return json(404, { message: 'Propietario no encontrado.' }, counter);
      const dueDay = Number(payload.automation && payload.automation.payment && payload.automation.payment.dueDay || 10);
      const score = sanitizedScore(scoreBuilder({
        owner,
        payments: payload.pagos || [],
        history,
        dueDay,
        now: now(),
        months: 12
      }));
      scoreCache.set(ownerId, { value: score, expiresAt: Date.now() + CACHE_TTL_MS });
      return json(200, score, counter, { 'X-Punctuality-Source': 'LEDGER_PAYMENT_HISTORY' });
    } catch (error) {
      console.error(JSON.stringify({ event: 'VLA_PUNCTUALITY_READ_ERROR', message: String(error && error.message || '').slice(0, 300) }));
      return json(503, { message: 'Índice temporalmente no disponible. Tu estado de cuenta no se ve afectado.' }, counter);
    }
  };
}

const handler = createHandler();
exports.handler = withAirtableUsage('public-punctuality-score', handler);
module.exports = { handler: exports.handler, createHandler, previewMode, previewScore, sanitizedScore };
