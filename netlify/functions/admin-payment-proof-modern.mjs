import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import legacy from './_admin_payment_proof.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/payment-proof',method:'GET'};
