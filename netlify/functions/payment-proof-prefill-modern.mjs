import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './payment-proof-prefill.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/payment-proof-prefill',method:'POST'};
