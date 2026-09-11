import { getStore } from '@netlify/blobs';
import store from './_shared/_communications_store.js';
import legacy from './_shared/_communications_admin_handler.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

store.configureNativeStore(getStore);

export default (request, context) => invokeLegacy(request, context, legacy.handler);

export const config = { path: '/api/vla/communications' };
