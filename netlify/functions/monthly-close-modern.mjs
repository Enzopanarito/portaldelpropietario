import legacy from './monthly-close.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/monthly-close',method:'POST'};
