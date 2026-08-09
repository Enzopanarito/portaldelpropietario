import 'nodemailer';
import 'pdfkit';
import legacy from './receipt-recovery-background.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default (request,context)=>invokeLegacy(request,context,legacy.handler);
export const config={path:'/api/vla/receipt-recovery',method:'POST',background:true};
