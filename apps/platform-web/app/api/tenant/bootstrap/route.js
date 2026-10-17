import { createControlPlaneRegistryFromEnv } from '../../../../lib/server/control-plane-registry.js';
import { createTenantBootstrapHandler } from '../../../../lib/server/tenant-bootstrap-handler.js';

export const dynamic = 'force-dynamic';

const handle = createTenantBootstrapHandler({
  registryFactory: () => createControlPlaneRegistryFromEnv()
});

export async function GET(request) {
  return handle(request);
}
