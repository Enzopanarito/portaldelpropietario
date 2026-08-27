'use strict';

const { withAirtableUsage } = require('./_shared/_airtable_meter');
const publicData = require('./public-data-v3');
const { getAll, TABLES } = require('./_shared/_monthly_close_store');
const { buildPunctualityScore } = require('./_shared/_punctuality_score_v2');

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
  const flag = String(env.VLA_PUNCTUALITY_PREVIEW_FIXTURE || '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
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
    score: 92, level: { key: 'EXCELENTE', label: 'Excelente', color: '#0f7a3a' }, evaluatedMonths: 3,
    targetMonths: 6, forming: true, levelProvisional: false, specialGraceDays: 30,
    streak: 1, trend: { key: 'SUBIENDO', label: 'Subiendo', symbol: '↑' }, dueDay: 10,
    history: [
      { month, score: 100, state: 'PUNTUAL', finalized: true, completionDate: `${month}-08`, completionDay: 8, commonScore: 100, specialScore: 100, specialInGrace: 0 },
      { month: previous(month, -1), score: 85, state: 'LEVE_RETRASO', finalized: true, completionDate: `${previous(month, -1)}-13`, completionDay: 13, commonScore: 85, specialScore: 100, specialInGrace: 0 },
      { month: previous(month, -2), score: 100, state: 'PUNTUAL', finalized: true, completionDate: `${previous(month, -2)}-07`, completionDay: 7, commonScore: 100, specialScore: 100, specialInGrace: 0 }
    ],
    anchor: { month: previous(month, -2), source: 'PREVIEW_FIXTURE' },
    advice: 'Mantén los gastos comunes cubiertos antes del día 10 y las cuotas especiales dentro de sus 30 días.',
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
    levelProvisional: score.levelProvisional === true,
    specialGraceDays: Number(score.specialGraceDays || 30),
    streak: score.streak,
    trend: score.trend,
    dueDay: score.dueDay,
    anchor: score.anchor ? { month: score.anchor.month, source: score.anchor.source } : null,
    history: (score.history || []).map(item => ({
      month: item.month,
      score: item.score,
      state: item.state,
      finalized: item.finalized,
      completionDate: item.completionDate || null,
      completionDay: item.completionDay || null,
      requiredReference: item.requiredReference,
      remainingReference: item.remainingReference,
      commonScore: item.commonScore ?? null,
      specialScore: item.specialScore ?? null,
      overdueScore: item.overdueScore ?? null,
      specialInGrace: Number(item.specialInGrace || 0),
      obligationsEvaluated: Number(item.obligationsEvaluated || 0),
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
      const [publicResult, expenses, history] = await Promise.all([
        publicResultPromise,
        listAll(TABLES.expenses, '', token, baseId, counter),
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
        expenses,
        history,
        dueDay,
        now: now(),
        months: 6
      }));
      scoreCache.set(ownerId, { value: score, expiresAt: Date.now() + CACHE_TTL_MS });
      return json(200, score, counter, { 'X-Punctuality-Source': 'LEDGER_AUDIT' });
    } catch (error) {
      console.error(JSON.stringify({ event: 'VLA_PUNCTUALITY_READ_ERROR', message: String(error && error.message || '').slice(0, 300) }));
      return json(503, { message: 'Índice temporalmente no disponible. Tu estado de cuenta no se ve afectado.' }, counter);
    }
  };
}

const handler = createHandler();
exports.handler = withAirtableUsage('public-punctuality-score', handler);
module.exports = { handler: exports.handler, createHandler, previewMode, previewScore, sanitizedScore };