import legacy from './public-punctuality-score.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

const DEPLOY_PREVIEW_HOST = /^deploy-preview-\d+--villalosapamates\.netlify\.app$/i;

export function isFixtureContext(context, request = null) {
  const deployContext = String(context?.deploy?.context || '').trim().toLowerCase();
  if (deployContext === 'deploy-preview' || deployContext === 'branch-deploy') return true;
  try {
    const host = new URL(request?.url || '').hostname;
    return DEPLOY_PREVIEW_HOST.test(host);
  } catch (_) {
    return false;
  }
}

export default async (request, context) => {
  const handler = legacy.createHandler({
    previewMode: () => isFixtureContext(context, request)
  });
  return invokeLegacy(request, context, handler);
};

export const config = {
  path: '/api/vla/punctuality-score'
};
