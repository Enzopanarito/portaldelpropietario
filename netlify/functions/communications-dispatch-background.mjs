import '@netlify/blobs';
import 'nodemailer';
import legacy from './_shared/_communications_dispatch_handler.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

export default (request, context) => invokeLegacy(request, context, legacy.handler);

export const config = { path: '/api/vla/communications-dispatch', method: 'POST', background: true };
