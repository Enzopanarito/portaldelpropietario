import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import 'sharp';
import fixed from './public-report-payment-fixed.js';

export default withLambda(fixed.handler);
export const config={path:'/api/vla/report-payment',method:'POST'};
