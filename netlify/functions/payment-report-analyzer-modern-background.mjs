import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import 'pdfkit';
import 'sharp';
import legacy from './payment-report-analyzer-background.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/payment-report-analyzer',method:'POST',background:true};
