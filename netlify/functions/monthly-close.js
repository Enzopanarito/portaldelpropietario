// netlify/functions/monthly-close.js
// Cierre mensual seguro con doble modalidad de pago, reconciliación de transición
// y bloqueo idempotente por período para impedir cierres duplicados o concurrentes.
// Al finalizar el cierre, sincroniza automáticamente el acceso cómodo del portón.

const crypto = require('crypto');
const { requireAdmin } = require('./_auth');
const { autoSyncAll } = require('./_access_control');

const TABLES = {
  propietarios: 'Propietarios',
  gastos: 'Gastos del Mes',
  pagos: 'Pagos',
  control: 'ControlVersiones'
};

const CLOSE_PREFIX = 'MONTHLY_CLOSE|';
const ACTIVE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

function json(statusCode, body, counter = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  };
  if (counter) headers['X-Airtable-Calls'] = String(counter.calls || 0);
  return { statusCode, headers, body: JSON.stringify(body) };
}

function currentMonthCaracas() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function normalizeMonth(value) {
  const month = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonthCaracas();
}

function buildUrl(baseId, tableName, query = '') {
  return `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}${query}`;
}

async function airtableGetAll(tableName, query, token, baseId, counter) {
  let records = [];
  let offset = null;
  const safeQuery = query || '';
  do {
    const sep = safeQuery ? '&' : '?';
    const url = buildUrl(baseId, tableName, `${safeQuery}${offset ? `${sep}offset=${encodeURIComponent(offset)}` : ''}`);
    counter.calls += 1;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error cargando ${tableName}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function airtablePatchRecords(tableName, records, token, baseId, counter) {
  const updated = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    if (!batch.length) continue;
    counter.calls += 1;
    const response = await fetch(buildUrl(baseId, tableName), {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `Error actualizando ${tableName}`);
    updated.push(...(data.records || []));
  }
  return updated;
}

async function airtableCreateRecord(tableName, fields, token, baseId, counter) {
  counter.calls += 1;
  const response = await fetch(buildUrl(baseId, tableName), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Error creando registro en ${tableName}`);
  return (data.records || [])[0] || null;
}

async function airtablePatchRecord(tableName, recordId, fields, token, baseId, counter) {
  const records = await airtablePatchRecords(tableName, [{ id: recordId, fields }], token, baseId, counter);
  return records[0] || null;
}

function money(v) {
  const n = Number(v || 0);
  return Math.round(n * 100) / 100;
}

function isAppliedPayment(record) {
  return record && record.fields && record.fields['[x] Aplicado al Cierre'] === true;
}

function hasLegacyIndividualCharges(gastos) {
  return gastos.some(g => String((g.fields || {}).Concepto || '').toLowerCase().includes('(cargo individual)'));
}

function ownerShare(gasto, owner) {
  const f = gasto.fields || {};
  const monto = Number(f.Monto || 0);
  const tipo = f['Tipo de Gasto'];
  const linked = f.Propietarios || [];
  const alicuota = Number((owner.fields || {}).Alicuota || 0);
  if (tipo === 'Gasto Común') return money(monto * alicuota);
  if (tipo === 'Gasto Especial' && linked.includes(owner.id)) return money(monto / (linked.length || 1));
  return 0;
}

function paymentEquivalentUsd(payment) {
  const f = payment.fields || {};
  return money(f['Equivalente USD Aplicado'] || f['Monto Pagado'] || 0);
}

function explicitNegativeSplit(total, initialUsd, initialBs, rawUsd, rawBsRef) {
  if (total >= -0.01) return { usd: 0, bsRef: 0 };
  if (initialUsd < -0.01 && Math.abs(initialBs) <= 0.01) return { usd: total, bsRef: 0 };
  if (initialBs < -0.01 && Math.abs(initialUsd) <= 0.01) return { usd: 0, bsRef: total };
  const nu = Math.max(0, -rawUsd), nb = Math.max(0, -rawBsRef), nt = nu + nb;
  if (nt <= 0.01) return { usd: 0, bsRef: total };
  if (nu > 0.01 && nb <= 0.01) return { usd: total, bsRef: 0 };
  if (nb > 0.01 && nu <= 0.01) return { usd: 0, bsRef: total };
  const usd = money(total * (nu / nt));
  return { usd, bsRef: money(total - usd) };
}

function calculateSplitBalance(owner, gastos, pagos, transitionMode) {
  const f = owner.fields || {};
  const initialUsd = Number(f['Deuda Anterior USD'] || 0);
  const initialBs = Number(f['Deuda Anterior Bs Ref'] || 0);
  const splitExists = Math.abs(initialUsd) > 0.001 || Math.abs(initialBs) > 0.001;
  let usdBalance = initialUsd;
  let bsRefBalance = initialBs;
  if (!splitExists) bsRefBalance += Number(f['Deuda Anterior'] || 0);

  gastos.forEach(g => {
    const share = ownerShare(g, owner);
    if (share <= 0) return;
    const mode = (g.fields || {})['Forma de Pago'] || 'Bs BCV';
    if (mode === 'USD') usdBalance += share;
    else bsRefBalance += share;
  });

  pagos
    .filter(p => !isAppliedPayment(p))
    .filter(p => ((p.fields || {})['Propietario que Paga'] || []).includes(owner.id))
    .forEach(p => {
      const mode = (p.fields || {})['Forma de Pago'] || 'Bs BCV';
      const amount = paymentEquivalentUsd(p);
      if (mode === 'USD') usdBalance -= amount;
      else bsRefBalance -= amount;
    });

  const rawUsd = money(usdBalance);
  const rawBsRef = money(bsRefBalance);
  const rawTotal = money(rawUsd + rawBsRef);
  const legacyTotal = money(f['Deuda Restante']);
  let finalUsd = rawUsd;
  let finalBsRef = rawBsRef;
  let totalRef = rawTotal;
  let reconciled = false;
  const difference = money(rawTotal - legacyTotal);

  if (transitionMode && Number.isFinite(legacyTotal)) {
    reconciled = true;
    totalRef = legacyTotal;
    if (legacyTotal <= 0.01) {
      const neg = explicitNegativeSplit(legacyTotal, initialUsd, initialBs, rawUsd, rawBsRef);
      finalUsd = neg.usd;
      finalBsRef = neg.bsRef;
    } else {
      const positiveUsd = Math.max(0, rawUsd);
      const positiveBs = Math.max(0, rawBsRef);
      const positiveTotal = positiveUsd + positiveBs;
      if (positiveTotal <= 0.01) {
        finalUsd = 0;
        finalBsRef = legacyTotal;
      } else {
        finalUsd = money(legacyTotal * (positiveUsd / positiveTotal));
        finalBsRef = money(legacyTotal - finalUsd);
      }
    }
  }

  return {
    usd: money(finalUsd),
    bsRef: money(finalBsRef),
    totalRef: money(totalRef),
    rawUsd,
    rawBsRef,
    rawTotal,
    legacyTotal,
    difference,
    reconciled
  };
}

function operationId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function closePrefix(month) {
  return `${CLOSE_PREFIX}${month}|`;
}

function closeKey(month, status, opId) {
  return `${closePrefix(month)}${status}|${opId}`;
}

function parseCloseMarker(record, month) {
  const key = String((record.fields || {}).Key || '');
  const prefix = closePrefix(month);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf('|');
  if (separator < 0) return null;
  return {
    record,
    id: record.id,
    status: rest.slice(0, separator),
    operationId: rest.slice(separator + 1),
    createdAt: Date.parse(record.createdTime || '')
  };
}

async function listCloseMarkers(month, token, baseId, counter) {
  const prefix = closePrefix(month);
  const formula = encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
  const records = await airtableGetAll(TABLES.control, `?filterByFormula=${formula}`, token, baseId, counter);
  return records.map(r => parseCloseMarker(r, month)).filter(Boolean);
}

async function setCloseMarker(marker, month, status, token, baseId, counter) {
  if (!marker || !marker.id) return null;
  const versions = { LOCKED: 1, DONE: 2, ERROR_SAFE: 3, ERROR_PARTIAL: 4, ABORTED: 5 };
  return airtablePatchRecord(TABLES.control, marker.id, {
    Key: closeKey(month, status, marker.operationId),
    Version: versions[status] || 1
  }, token, baseId, counter);
}

async function acquireCloseLock(month, token, baseId, counter) {
  const existing = await listCloseMarkers(month, token, baseId, counter);
  const completed = existing.find(m => m.status === 'DONE');
  if (completed) {
    return { ok: false, status: 'already-closed', marker: completed };
  }

  const partial = existing.find(m => m.status === 'ERROR_PARTIAL');
  if (partial) {
    return { ok: false, status: 'partial-error', marker: partial };
  }

  const opId = operationId();
  const created = await airtableCreateRecord(TABLES.control, {
    Key: closeKey(month, 'LOCKED', opId),
    Version: 1
  }, token, baseId, counter);
  const ownMarker = parseCloseMarker(created, month);
  if (!ownMarker) throw new Error('No se pudo crear el bloqueo seguro del cierre mensual.');

  const reread = await listCloseMarkers(month, token, baseId, counter);
  const doneAfterCreate = reread.find(m => m.status === 'DONE');
  if (doneAfterCreate) {
    await setCloseMarker(ownMarker, month, 'ABORTED', token, baseId, counter).catch(() => null);
    return { ok: false, status: 'already-closed', marker: doneAfterCreate };
  }

  const partialAfterCreate = reread.find(m => m.status === 'ERROR_PARTIAL');
  if (partialAfterCreate) {
    await setCloseMarker(ownMarker, month, 'ABORTED', token, baseId, counter).catch(() => null);
    return { ok: false, status: 'partial-error', marker: partialAfterCreate };
  }

  const cutoff = Date.now() - ACTIVE_LOCK_TTL_MS;
  const activeLocks = reread
    .filter(m => m.status === 'LOCKED')
    .filter(m => m.id === ownMarker.id || !Number.isFinite(m.createdAt) || m.createdAt >= cutoff)
    .sort((a, b) => {
      const timeA = Number.isFinite(a.createdAt) ? a.createdAt : Number.MAX_SAFE_INTEGER;
      const timeB = Number.isFinite(b.createdAt) ? b.createdAt : Number.MAX_SAFE_INTEGER;
      return timeA - timeB || String(a.id).localeCompare(String(b.id));
    });

  const winner = activeLocks[0];
  if (!winner || winner.id !== ownMarker.id) {
    await setCloseMarker(ownMarker, month, 'ABORTED', token, baseId, counter).catch(() => null);
    return { ok: false, status: 'in-progress', marker: winner || null };
  }

  return { ok: true, marker: ownMarker };
}

exports.handler = async function(event) {
  const auth = requireAdmin(event);
  if (!auth.ok) return auth.response;

  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
  const counter = { calls: 0 };
  if (event.httpMethod !== 'POST') return json(405, { message: 'Method Not Allowed' }, counter);
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return json(500, { message: 'Airtable no está configurado.' }, counter);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { body = {}; }
  const dryRun = body.dryRun === true;
  const month = normalizeMonth(body.month);
  if (!dryRun && body.confirmed !== true) {
    return json(400, { message: 'Debe confirmar explícitamente el cierre de mes.' }, counter);
  }

  let closeLock = null;
  let writeStage = 0;

  try {
    if (!dryRun) {
      const lockResult = await acquireCloseLock(month, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
      if (!lockResult.ok) {
        const messages = {
          'already-closed': `El mes ${month} ya fue cerrado. No se ejecutó nuevamente para evitar duplicar la deuda.`,
          'in-progress': `Ya existe un cierre de ${month} en proceso. Espere y revise el resultado antes de intentar otra vez.`,
          'partial-error': `Existe un cierre parcial de ${month} que requiere revisión. No se permite reintentar automáticamente para proteger los saldos.`
        };
        return json(409, {
          success: false,
          protected: true,
          closeStatus: lockResult.status,
          month,
          message: messages[lockResult.status] || 'El cierre está protegido y no puede ejecutarse en este momento.'
        }, counter);
      }
      closeLock = lockResult.marker;
    }

    const [propietarios, gastos, pagos] = await Promise.all([
      airtableGetAll(TABLES.propietarios, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.gastos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter),
      airtableGetAll(TABLES.pagos, '', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter)
    ]);

    if (!propietarios.length) {
      throw new Error('No se encontraron propietarios para cerrar el mes.');
    }

    const transitionMode = hasLegacyIndividualCharges(gastos);
    const balancesByOwner = propietarios.map(owner => ({
      owner,
      balance: calculateSplitBalance(owner, gastos, pagos, transitionMode)
    }));
    const totalUsd = money(balancesByOwner.reduce((s, x) => s + x.balance.usd, 0));
    const totalBsRef = money(balancesByOwner.reduce((s, x) => s + x.balance.bsRef, 0));
    const totalRef = money(balancesByOwner.reduce((s, x) => s + x.balance.totalRef, 0));
    const rawTotal = money(balancesByOwner.reduce((s, x) => s + x.balance.rawTotal, 0));
    const legacyTotal = money(balancesByOwner.reduce((s, x) => s + x.balance.legacyTotal, 0));
    const differences = balancesByOwner
      .filter(x => Math.abs(x.balance.difference) > 0.01)
      .map(x => ({
        ownerId: x.owner.id,
        casa: x.owner.fields?.Casa,
        propietario: x.owner.fields?.Propietario,
        rawTotal: x.balance.rawTotal,
        legacyTotal: x.balance.legacyTotal,
        difference: x.balance.difference
      }));

    const validation = {
      month,
      transitionMode,
      totalUsd,
      totalBsRef,
      totalRef,
      rawTotal,
      legacyTotal,
      difference: money(rawTotal - legacyTotal),
      differences,
      differenceCount: differences.length,
      conDeudaUsd: balancesByOwner.filter(x => x.balance.usd > 0.01).length,
      conDeudaBs: balancesByOwner.filter(x => x.balance.bsRef > 0.01).length,
      conSaldoFavor: balancesByOwner.filter(x => x.balance.totalRef < -0.01).length,
      pendingPaymentsCount: pagos.filter(p => !isAppliedPayment(p)).length
    };

    if (dryRun) {
      return json(200, { success: true, dryRun: true, validation }, counter);
    }

    const ownerUpdates = balancesByOwner.map(({ owner, balance }) => ({
      id: owner.id,
      fields: {
        'Deuda Anterior USD': balance.usd,
        'Deuda Anterior Bs Ref': balance.bsRef,
        'Deuda Anterior': balance.totalRef
      }
    }));
    const updatedOwners = await airtablePatchRecords(
      TABLES.propietarios,
      ownerUpdates,
      AIRTABLE_API_TOKEN,
      AIRTABLE_BASE_ID,
      counter
    );
    writeStage = 1;

    const pendingPaymentsToClose = pagos
      .filter(p => !isAppliedPayment(p))
      .map(p => ({ id: p.id, fields: { '[x] Aplicado al Cierre': true } }));
    const updatedPayments = await airtablePatchRecords(
      TABLES.pagos,
      pendingPaymentsToClose,
      AIRTABLE_API_TOKEN,
      AIRTABLE_BASE_ID,
      counter
    );
    writeStage = 2;

    let accessSync = null;
    try {
      accessSync = await autoSyncAll({ sendEmail: true });
    } catch (error) {
      accessSync = { success: false, error: error.message };
    }

    let markerWarning = null;
    try {
      await setCloseMarker(closeLock, month, 'DONE', AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
    } catch (error) {
      markerWarning = `El cierre terminó, pero no se pudo actualizar su marcador de control: ${error.message}`;
      try {
        await airtableCreateRecord(TABLES.control, {
          Key: closeKey(month, 'DONE', closeLock.operationId),
          Version: 2
        }, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter);
        markerWarning = null;
      } catch (_) {}
    }

    const accessErrors = Number(accessSync && accessSync.errors || 0);
    const accessFailed = accessSync && accessSync.success === false;
    const accessWarning = accessFailed || accessErrors > 0;

    return json(200, {
      success: true,
      month,
      closeOperationId: closeLock.operationId,
      updatedCount: updatedOwners.length,
      paymentsClosedCount: updatedPayments.length,
      validation,
      accessSync,
      warning: markerWarning || (accessWarning ? 'El cierre contable terminó, pero uno o más accesos requieren revisión o reintento.' : null),
      message: accessWarning
        ? 'Cierre de mes realizado correctamente. La sincronización del portón terminó con advertencias.'
        : 'Cierre de mes realizado correctamente con saldos separados USD y Bs BCV. Accesos sincronizados automáticamente.'
    }, counter);
  } catch (error) {
    if (closeLock) {
      const status = writeStage === 0 ? 'ERROR_SAFE' : 'ERROR_PARTIAL';
      await setCloseMarker(closeLock, month, status, AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, counter).catch(() => null);
    }
    return json(500, {
      success: false,
      month,
      partial: writeStage > 0,
      protected: true,
      message: writeStage > 0
        ? 'El cierre se interrumpió después de realizar cambios. No lo repita. Debe revisarse antes de cualquier nuevo intento.'
        : 'Error realizando cierre de mes. No se aplicaron cambios contables y puede revisarse con seguridad.',
      detail: error.message
    }, counter);
  }
};