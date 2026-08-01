import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './monthly-close.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/monthly-close',method:'POST'};
