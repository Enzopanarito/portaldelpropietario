import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import 'pdfkit';
import legacy from './receipt-recovery-background.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/receipt-recovery',method:'POST',background:true};
