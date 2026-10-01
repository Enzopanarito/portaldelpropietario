import legacy from './monthly-close-watchdog-scheduled.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={schedule:'*/5 * 1 * *'};
