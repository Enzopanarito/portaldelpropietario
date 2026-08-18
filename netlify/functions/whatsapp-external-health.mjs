import {
  evaluateStatus,
  relayStatus,
  unreachableHealth
} from './_shared/_whatsapp_external_monitor.mjs';

function env(name) {
  return String(Netlify.env.get(name) || '').trim();
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json({ ok: false, status: 'method-not-allowed' }, 405);

  let health;
  try {
    const status = await relayStatus({
      url: env('VLA_WHATSAPP_CONTROL_URL'),
      secret: env('VLA_WHATSAPP_CONTROL_SECRET'),
      timeoutMs: 15000
    });
    health = evaluateStatus(status);
  } catch (error) {
    health = unreachableHealth(error?.code === 'MONITOR_CONFIG_MISSING' ? 'MONITOR_CONFIG_MISSING' : 'MAC_OR_GATEWAY_UNREACHABLE');
  }

  const body = {
    ok: health.healthy,
    status: health.status,
    reasons: health.reasons,
    checkedAt: new Date().toISOString()
  };
  return json(body, health.healthy ? 200 : 503);
};
