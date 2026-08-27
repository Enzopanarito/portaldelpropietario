import 'nodemailer';
import legacy from './payment-report-analyzer-background.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/payment-report-analyzer',method:'POST',background:true};
