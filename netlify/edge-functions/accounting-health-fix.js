const RELEASE = '2026-08-02-accounting-health-v1';
const LEGACY_MARKER = '(cargo individual)';

function countFromDetail(detail = '') {
  const match = String(detail).match(/(\d+)\s+cargo\(s\)/i);
  return match ? Number(match[1]) : 0;
}

function isLegacyExpense(expense) {
  const fields = expense && expense.fields ? expense.fields : expense || {};
  return String(fields.Concepto || '').toLowerCase().includes(LEGACY_MARKER);
}

function jsonResponse(response, payload) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-vla-accounting-health-fix', RELEASE);
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json') || !response.ok) return response;

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return response;
  }

  const checks = Array.isArray(payload && payload.checks) ? payload.checks : null;
  if (!checks) return jsonResponse(response, payload);

  const accounting = checks.find(check => check && check.name === 'Modo contable');
  if (!accounting) return jsonResponse(response, payload);

  try {
    const origin = new URL(request.url).origin;
    const publicResponse = await fetch(`${origin}/api/vla/public-data`, {
      headers: { Accept: 'application/json' }
    });
    if (!publicResponse.ok) return jsonResponse(response, payload);

    const publicData = await publicResponse.json();
    const activeExpenses = Array.isArray(publicData && publicData.gastos) ? publicData.gastos : [];
    const activeLegacyCount = activeExpenses.filter(isLegacyExpense).length;
    const historicalLegacyCount = Math.max(0, countFromDetail(accounting.detail) - activeLegacyCount);

    accounting.ok = activeLegacyCount === 0;
    accounting.severity = activeLegacyCount > 0 ? 'warning' : 'ok';
    accounting.detail = activeLegacyCount > 0
      ? `Transición activa: ${activeLegacyCount} cargo(s) individual(es) legacy vigentes en el mes operativo. Históricos excluidos: ${historicalLegacyCount}.`
      : historicalLegacyCount > 0
        ? `Modo doble moneda limpio. ${historicalLegacyCount} cargo(s) individual(es) legacy están cerrados como histórico y no participan en el cálculo actual.`
        : 'Modo doble moneda limpio.';
    accounting.meta = {
      ...(accounting.meta || {}),
      activeLegacyCount,
      historicalLegacyCount,
      source: 'active-expense-lifecycle'
    };

    const hasError = checks.some(check => check && check.severity === 'error');
    const hasWarning = checks.some(check => check && check.severity === 'warning');
    payload.ok = !hasError;
    payload.status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';
  } catch (_) {
    // Fail open for the diagnostic response: never block the Health panel.
  }

  return jsonResponse(response, payload);
};
