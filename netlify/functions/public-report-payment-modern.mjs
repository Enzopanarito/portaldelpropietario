import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import 'sharp';
import legacy from './public-report-payment.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/report-payment',method:'POST'};
