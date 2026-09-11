'use strict';

const crypto = require('crypto');
const store = require('./_shared/_monthly_close_store_v5');
const { verifyCloseRecoveryOidcToken } = require('./_shared/_github_oidc_close_recovery');
const { money, hashJson, currentDebtValues, compareDebtValues } = require('./_shared/_monthly_close_core');
const { concept, snapshotHash, validateSnapshotRecords } = require('./_shared/_monthly_close_snapshot');
const { parseCandidate } = require('./monthly-close-v5');

const MONTH = '2026-08';
const OPERATION_ID = 'manual-recovery-20260901-1209';
const OPERATION_LOG_ID = 'recUftAAvcEnmz64v';
const EXPECTED_PLAN_HASH = '69365ce1334bbd28f9f9e766c2165809363a7dde9a37e11e26bbf571d1499816';
const EXPECTED_SOURCE_HASH = 'fd4e3eabb9eb7238888aafeae8a38438970b9ca6e2ccd504508530099a75eae4';
const EXPECTED_SNAPSHOT_HASH = '31ad7bbda9e612b582a0713e5cb63464b290eb30c8bfa5db7d9e0a6b0f7b227b';
const HISTORICAL_BACKUP_ARTIFACT_ID = 9798993246;
const HISTORICAL_PLAN_PROOF_ARTIFACT_ID = 9828773426;
const NORMALIZED_RULES = Object.freeze({ dueDay: 10, surchargeRate: 0.1 });
const EXPECTED_PAYMENT_COUNT = 48;
const EXPECTED_OWNER_COUNT = 15;

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify(payload)
  };
}
function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
function linkedIds(value) {
  return Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item && item.id).filter(Boolean).sort()
    : [];
}
function snapshotActualHash(records) {
  const entries = (records || []).map(record => {
    const fields = record?.fields || {};
    const owners = linkedIds(fields.Propietario);
    return {
      concept: String(fields.Concepto || ''),
      ownerId: String(owners[0] || ''),
      amount: money(fields['Monto Cargado'])
    };
  }).filter(entry => entry.concept.startsWith(`AUDITORIA|${MONTH}|`));
  return { count: entries.length, hash: snapshotHash(entries) };
}
function paymentFilterQuery(paymentIds) {
  const clauses = paymentIds.map(id => `RECORD_ID()='${String(id).replace(/'/g, "\\'")}'`);
  return `?filterByFormula=${encodeURIComponent(`OR(${clauses.join(',')})`)}&pageSize=100`;
}
function normalizePaymentIds(value) {
  if (!Array.isArray(value) || value.length !== EXPECTED_PAYMENT_COUNT) throw new Error('PAYMENT_IDS_COUNT_INVALID');
  const ids = value.map(id => String(id || '').trim());
  if (ids.some(id => !/^rec[A-Za-z0-9]{14}$/.test(id))) throw new Error('PAYMENT_ID_INVALID');
  const unique = [...new Set(ids)].sort();
  if (unique.length !== EXPECTED_PAYMENT_COUNT) throw new Error('PAYMENT_IDS_DUPLICATED');
  return unique;
}
function recordAmountByConcept(records, ownerId, exactConcept) {
  const matches = (records || []).filter(record => {
    const fields = record?.fields || {};
    const owners = linkedIds(fields.Propietario);
    return String(fields.Concepto || '') === exactConcept && owners.length === 1 && owners[0] === ownerId;
  });
  if (matches.length !== 1) throw new Error(`SNAPSHOT_ROW_INVALID:${exactConcept}`);
  return money(matches[0]?.fields?.['Monto Cargado']);
}
function finalTotalRow(records, ownerId, prefix, ownerName) {
  const start = `${prefix}Saldo final total (`;
  const end = ` | ${ownerName}`;
  const matches = (records || []).filter(record => {
    const fields = record?.fields || {};
    const name = String(fields.Concepto || '');
    const owners = linkedIds(fields.Propietario);
    return name.startsWith(start) && name.endsWith(end) && owners.length === 1 && owners[0] === ownerId;
  });
  if (matches.length !== 1) throw new Error(`SNAPSHOT_FINAL_TOTAL_INVALID:${ownerId}`);
  return money(matches[0]?.fields?.['Monto Cargado']);
}
function buildPlanFromSnapshot(owners, snapshotRecords, paymentIds) {
  if (!Array.isArray(owners) || owners.length !== EXPECTED_OWNER_COUNT) throw new Error(`OWNER_COUNT_INVALID:${owners?.length || 0}`);
  const ownerUpdates = [...owners].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(owner => {
    const fields = owner?.fields || {};
    const ownerId = String(owner.id || '');
    const casa = Number(fields.Casa);
    const ownerName = String(fields.Propietario || '');
    if (!ownerId || !Number.isInteger(casa) || casa < 1 || casa > 15 || !ownerName) throw new Error(`OWNER_IDENTITY_INVALID:${ownerId}`);
    const prefix = `AUDITORIA|${MONTH}|Casa ${casa}|`;
    const amount = label => recordAmountByConcept(snapshotRecords, ownerId, concept(MONTH, casa, label, ownerName));
    const priorUsd = amount('Saldo inicial USD');
    const priorBsRef = amount('Saldo inicial Bs Ref');
    const chargesUsd = amount('Cargos USD');
    const chargesBsRef = amount('Cargos Bs Ref');
    const paidUsd = Math.abs(amount('Pagos USD'));
    const paidBsRef = Math.abs(amount('Pagos Bs Ref'));
    const finalUsd = amount('Saldo final USD');
    const finalBsRef = amount('Saldo final Bs Ref');
    const finalTotal = finalTotalRow(snapshotRecords, ownerId, prefix, ownerName);
    const before = {
      deudaAnteriorUsd: priorUsd,
      deudaAnteriorBsRef: priorBsRef,
      deudaAnterior: money(priorUsd + priorBsRef)
    };
    const target = {
      deudaAnteriorUsd: finalUsd,
      deudaAnteriorBsRef: finalBsRef,
      deudaAnterior: finalTotal
    };
    return {
      id: ownerId,
      casa,
      propietario: ownerName,
      before,
      target,
      calculation: {
        priorUsd,
        priorBsRef,
        chargesUsd,
        chargesBsRef,
        paidUsd,
        paidBsRef,
        usd: finalUsd,
        bsRef: finalBsRef,
        totalRef: finalTotal,
        rawUsd: finalUsd,
        rawBsRef: finalBsRef,
        rawTotal: finalTotal,
        reconciled: false
      }
    };
  });
  const houses = ownerUpdates.map(item => item.casa).sort((a, b) => a - b);
  if (houses.some((house, index) => house !== index + 1)) throw new Error('OWNER_HOUSES_NOT_15_15');
  const normalizedPaymentIds = normalizePaymentIds(paymentIds);
  const invalidPaymentIds = [];
  const computedPlanHash = hashJson({
    version: 8,
    month: MONTH,
    sourceHash: EXPECTED_SOURCE_HASH,
    normalizedRules: NORMALIZED_RULES,
    ownerUpdates: ownerUpdates.map(item => ({ id: item.id, before: item.before, target: item.target })),
    paymentIds: normalizedPaymentIds,
    invalidPaymentIds
  });
  if (computedPlanHash !== EXPECTED_PLAN_HASH) throw new Error(`PLAN_HASH_MISMATCH:${computedPlanHash}`);
  const totalUsd = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnteriorUsd, 0));
  const totalBsRef = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnteriorBsRef, 0));
  const totalRef = money(ownerUpdates.reduce((sum, item) => sum + item.target.deudaAnterior, 0));
  const creditBalanceCount = ownerUpdates.filter(item => item.target.deudaAnterior < -0.01).length;
  const currencyCreditComponentCount = ownerUpdates.filter(item => item.target.deudaAnteriorUsd < -0.01 || item.target.deudaAnteriorBsRef < -0.01).length;
  return {
    version: 7,
    month: MONTH,
    generatedAt: '2026-09-01T12:08:46.875Z',
    transitionMode: false,
    sourceHash: EXPECTED_SOURCE_HASH,
    planHash: EXPECTED_PLAN_HASH,
    normalizedRules: { ...NORMALIZED_RULES },
    ownerUpdates,
    paymentIds: normalizedPaymentIds,
    validation: {
      month: MONTH,
      transitionMode: false,
      totalUsd,
      totalBsRef,
      totalRef,
      creditBalanceCount,
      currencyCreditComponentCount,
      pendingPaymentsCount: normalizedPaymentIds.length,
      paymentCutoff: '2026-08-31',
      invalidPaymentDatesCount: 0,
      invalidPaymentIds: [],
      futurePaymentsExcludedCount: 0,
      futurePaymentIds: [],
      closeScopeReady: true,
      ownerCount: ownerUpdates.length
    }
  };
}
function verifyCurrentOwners(owners, plan) {
  const byId = new Map((owners || []).map(owner => [String(owner.id), owner]));
  const differences = [];
  for (const item of plan.ownerUpdates || []) {
    const owner = byId.get(item.id);
    if (!owner) { differences.push({ ownerId: item.id, reason: 'missing' }); continue; }
    const comparison = compareDebtValues(item.target, currentDebtValues(owner));
    if (!comparison.ok) differences.push({ ownerId: item.id, casa: item.casa, reason: 'target-mismatch' });
  }
  return { ok: differences.length === 0, differences };
}
function verifyAppliedPayments(payments, paymentIds) {
  const byId = new Map((payments || []).map(payment => [String(payment.id), payment]));
  const differences = [];
  for (const id of paymentIds) {
    const payment = byId.get(id);
    if (!payment) { differences.push({ paymentId: id, reason: 'missing' }); continue; }
    if (payment?.fields?.['[x] Aplicado al Cierre'] !== true) differences.push({ paymentId: id, reason: 'not-applied' });
  }
  return { ok: differences.length === 0, differences };
}
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const handler = async function(event) {
  if (event?.httpMethod !== 'POST') return response(405, { success: false, code: 'METHOD_NOT_ALLOWED' });
  let request = {};
  try { request = JSON.parse(event.body || '{}'); }
  catch (_) { return response(400, { success: false, code: 'INVALID_JSON' }); }
  const oidcToken = String(request.oidcToken || '');
  if (!oidcToken || oidcToken.length > 20000) return response(401, { success: false, code: 'OIDC_REQUIRED' });
  try { await verifyCloseRecoveryOidcToken(oidcToken); }
  catch (error) {
    console.warn(JSON.stringify({ event: 'VLA_CLOSE_RECOVERY_OIDC_REJECTED', code: String(error.message || '').slice(0, 80) }));
    return response(401, { success: false, code: 'OIDC_REJECTED' });
  }

  let paymentIds;
  try { paymentIds = normalizePaymentIds(request.paymentIds); }
  catch (error) { return response(400, { success: false, code: String(error.message || 'PAYMENT_IDS_INVALID') }); }

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return response(500, { success: false, code: 'AIRTABLE_NOT_CONFIGURED' });
  const counter = { calls: 0 };
  let originalSummary = null;
  let wrote = false;

  try {
    const markers = await store.listCloseMarkers(MONTH, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const doneMarkers = markers.filter(marker => marker.status === 'DONE');
    if (doneMarkers.length !== 1 || doneMarkers[0].operationId !== OPERATION_ID) {
      return response(409, { success: false, code: 'DONE_MARKER_UNEXPECTED', airtableCalls: counter.calls });
    }
    await sleep(300);

    const log = await store.getRecord(store.TABLES.operations, OPERATION_LOG_ID, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const expectedCierre = store.operationName(MONTH, OPERATION_ID);
    if (String(log?.fields?.Cierre || '') !== expectedCierre) {
      return response(409, { success: false, code: 'OPERATION_LOG_IDENTITY_MISMATCH', airtableCalls: counter.calls });
    }
    const existingCandidate = parseCandidate(log, MONTH);
    if (existingCandidate.ok) {
      if (existingCandidate.plan.planHash !== EXPECTED_PLAN_HASH || existingCandidate.plan.sourceHash !== EXPECTED_SOURCE_HASH) {
        return response(409, { success: false, code: 'EXISTING_PLAN_HASH_UNEXPECTED', airtableCalls: counter.calls });
      }
      return response(200, { success: true, alreadyRepaired: true, month: MONTH, planHash: EXPECTED_PLAN_HASH, sourceHash: EXPECTED_SOURCE_HASH, airtableCalls: counter.calls });
    }
    if (existingCandidate.reason !== 'STORED_PLAN_INVALID') {
      return response(409, { success: false, code: 'UNEXPECTED_CERTIFICATION_STATE', reason: existingCandidate.reason, airtableCalls: counter.calls });
    }
    originalSummary = String(log?.fields?.['Resumen JSON'] || '');
    let originalPayload = {};
    try { originalPayload = JSON.parse(originalSummary || '{}'); } catch (_) { originalPayload = {}; }
    await sleep(300);

    const owners = await store.getAll(store.TABLES.owners, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    await sleep(300);
    const snapshotRecords = await store.getAll(store.TABLES.history, store.snapshotQuery(MONTH), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const rawSnapshot = snapshotActualHash(snapshotRecords);
    if (rawSnapshot.count !== 150 || rawSnapshot.hash !== EXPECTED_SNAPSHOT_HASH) {
      return response(409, { success: false, code: 'HISTORICAL_SNAPSHOT_HASH_MISMATCH', snapshotCount: rawSnapshot.count, snapshotHash: rawSnapshot.hash, airtableCalls: counter.calls });
    }

    const plan = buildPlanFromSnapshot(owners, snapshotRecords, paymentIds);
    const snapshotVerification = validateSnapshotRecords(snapshotRecords, plan);
    if (!snapshotVerification.complete || snapshotVerification.expectedHash !== EXPECTED_SNAPSHOT_HASH || snapshotVerification.actualHash !== EXPECTED_SNAPSHOT_HASH) {
      return response(409, { success: false, code: 'SNAPSHOT_PLAN_VERIFICATION_FAILED', snapshotCount: snapshotVerification.count, airtableCalls: counter.calls });
    }
    const ownerVerification = verifyCurrentOwners(owners, plan);
    if (!ownerVerification.ok) {
      return response(409, { success: false, code: 'OWNER_TARGET_VERIFICATION_FAILED', differenceCount: ownerVerification.differences.length, airtableCalls: counter.calls });
    }
    await sleep(300);

    const payments = await store.getAll(store.TABLES.payments, paymentFilterQuery(paymentIds), AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const paymentVerification = verifyAppliedPayments(payments, paymentIds);
    if (!paymentVerification.ok || payments.length !== EXPECTED_PAYMENT_COUNT) {
      return response(409, { success: false, code: 'PAYMENT_APPLICATION_VERIFICATION_FAILED', found: payments.length, differenceCount: paymentVerification.differences.length, airtableCalls: counter.calls });
    }

    const recoveredAt = new Date().toISOString();
    const recoveredPayload = {
      ...originalPayload,
      month: MONTH,
      operationId: OPERATION_ID,
      state: 'ACCOUNTING_COMPLETED',
      plan,
      progress: {
        ...(originalPayload.progress && typeof originalPayload.progress === 'object' ? originalPayload.progress : {}),
        ownersApplied: plan.ownerUpdates.map(item => item.id),
        paymentsApplied: paymentIds
      },
      closeCertificationRecovery: {
        schemaVersion: 1,
        recoveredAt,
        reason: 'RESTORE_MISSING_CANONICAL_PLAN_FROM_VERIFIED_PRE_CLOSE_EVIDENCE',
        priorSummarySha256: sha256Text(originalSummary),
        evidence: {
          historicalBackupArtifactId: HISTORICAL_BACKUP_ARTIFACT_ID,
          historicalPlanProofArtifactId: HISTORICAL_PLAN_PROOF_ARTIFACT_ID,
          planHash: EXPECTED_PLAN_HASH,
          sourceHash: EXPECTED_SOURCE_HASH,
          snapshotHash: EXPECTED_SNAPSHOT_HASH,
          ownerTargetsVerified: EXPECTED_OWNER_COUNT,
          paymentsAppliedVerified: EXPECTED_PAYMENT_COUNT
        }
      }
    };

    await sleep(300);
    await store.patchRecord(store.TABLES.operations, OPERATION_LOG_ID, { 'Resumen JSON': JSON.stringify(recoveredPayload) }, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    wrote = true;
    await sleep(300);

    const reread = await store.getRecord(store.TABLES.operations, OPERATION_LOG_ID, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    const candidate = parseCandidate(reread, MONTH);
    if (!candidate.ok || candidate.plan.planHash !== EXPECTED_PLAN_HASH || candidate.plan.sourceHash !== EXPECTED_SOURCE_HASH) throw new Error('POST_WRITE_STORED_PLAN_INVALID');
    const postSnapshot = validateSnapshotRecords(snapshotRecords, candidate.plan);
    const postOwners = verifyCurrentOwners(owners, candidate.plan);
    const postPayments = verifyAppliedPayments(payments, candidate.plan.paymentIds);
    if (!postSnapshot.complete || postSnapshot.actualHash !== EXPECTED_SNAPSHOT_HASH || !postOwners.ok || !postPayments.ok) throw new Error('POST_WRITE_EVIDENCE_MISMATCH');

    return response(200, {
      success: true,
      repaired: true,
      month: MONTH,
      operationId: OPERATION_ID,
      logId: OPERATION_LOG_ID,
      planHash: EXPECTED_PLAN_HASH,
      sourceHash: EXPECTED_SOURCE_HASH,
      snapshotHash: EXPECTED_SNAPSHOT_HASH,
      snapshot: { count: postSnapshot.count, expected: postSnapshot.expected, complete: postSnapshot.complete },
      ownersVerified: EXPECTED_OWNER_COUNT,
      paymentsVerified: EXPECTED_PAYMENT_COUNT,
      airtableCalls: counter.calls
    });
  } catch (error) {
    const code = String(error?.message || 'RECOVERY_FAILED').slice(0, 160);
    if (wrote && originalSummary !== null) {
      try {
        await sleep(300);
        await store.patchRecord(store.TABLES.operations, OPERATION_LOG_ID, { 'Resumen JSON': originalSummary }, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
        return response(500, { success: false, code, rolledBack: true, airtableCalls: counter.calls });
      } catch (rollbackError) {
        console.error(JSON.stringify({ event: 'VLA_CLOSE_RECOVERY_ROLLBACK_FAILED', code, rollback: String(rollbackError?.message || '').slice(0, 160) }));
        return response(500, { success: false, code, rolledBack: false, rollbackFailed: true, airtableCalls: counter.calls });
      }
    }
    console.error(JSON.stringify({ event: 'VLA_CLOSE_RECOVERY_FAILED', code }));
    return response(500, { success: false, code, rolledBack: false, airtableCalls: counter.calls });
  }
};

exports.handler = handler;
exports.buildPlanFromSnapshot = buildPlanFromSnapshot;
exports.normalizePaymentIds = normalizePaymentIds;
exports.snapshotActualHash = snapshotActualHash;
