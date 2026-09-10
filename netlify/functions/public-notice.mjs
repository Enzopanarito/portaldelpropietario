import legacy from './_shared/_communications_notice_handler.js';
import { invokeLegacy } from './_shared/legacy-function-bridge.mjs';

export default (request, context) => invokeLegacy(request, context, legacy.handler);
