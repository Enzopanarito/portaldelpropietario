import legacy from './access-reconciliation-scheduled.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={schedule:'5 * * * *'};
