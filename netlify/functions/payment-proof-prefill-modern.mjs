import legacy from './payment-proof-prefill.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/payment-proof-prefill',method:'POST'};
