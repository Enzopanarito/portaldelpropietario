import legacy from './_shared/_plant_admin_handler.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

export default (request, context) => invokeLegacy(request, context, legacy.handler);
export const config = { path: '/api/vla/admin/plant', method: ['GET', 'POST'] };
