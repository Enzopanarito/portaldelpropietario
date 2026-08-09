import 'nodemailer';
import legacy from './access-reconciliation-background.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/access-reconciliation',method:'POST',background:true};
