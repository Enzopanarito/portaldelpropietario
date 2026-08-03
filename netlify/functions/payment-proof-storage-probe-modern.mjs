import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './payment-proof-storage-probe.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/internal/payment-proof-storage-probe-20260803',method:'GET'};
