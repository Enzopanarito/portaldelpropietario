import 'nodemailer';
import legacy from './condo-autopilot-background.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/condo-autopilot',method:'POST',background:true};
