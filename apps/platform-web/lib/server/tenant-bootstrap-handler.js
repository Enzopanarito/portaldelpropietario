import { resolveTenantBootstrap } from './tenant-bootstrap.js';

function publicError(error) {
  const code = error?.code || 'TENANT_BOOTSTRAP_FAILED';
  if (code === 'TENANT_HOST_INVALID') return { status: 400, code };
  if (code === 'TENANT_NOT_AVAILABLE') return { status: 404, code };
  if (code === 'CONTROL_PLANE_QUERY_FAILED') {
    return { status: 502, code: 'TENANT_REGISTRY_UPSTREAM_UNAVAILABLE' };
  }
  if (code.startsWith('CONTROL_PLANE_')) {
    return { status: 503, code: 'TENANT_REGISTRY_UNAVAILABLE' };
  }
  return { status: 500, code: 'TENANT_BOOTSTRAP_FAILED' };
}

export function createTenantBootstrapHandler({ registryFactory }) {
  if (typeof registryFactory !== 'function') {
    throw new TypeError('registryFactory is required');
  }

  return async function handle(request) {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
    try {
      const registry = registryFactory();
      const bootstrap = await resolveTenantBootstrap({
        host,
        lookupByHostname: registry.lookupByHostname
      });
      return Response.json({ ok: true, tenant: bootstrap }, {
        status: 200,
        headers: { 'Cache-Control': 'private, no-store' }
      });
    } catch (error) {
      const exposed = publicError(error);
      return Response.json({ ok: false, code: exposed.code }, {
        status: exposed.status,
        headers: { 'Cache-Control': 'no-store' }
      });
    }
  };
}
