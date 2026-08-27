import legacy from './public-punctuality-score.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

export function isFixtureContext(context) {
  const deployContext = String(context?.deploy?.context || '').trim().toLowerCase();
  return deployContext === 'deploy-preview' || deployContext === 'branch-deploy';
}

export default async (request, context) => {
  const handler = legacy.createHandler({
    previewMode: () => isFixtureContext(context)
  });
  return invokeLegacy(request, context, handler);
};

export const config = {
  path: '/api/vla/punctuality-score'
};
