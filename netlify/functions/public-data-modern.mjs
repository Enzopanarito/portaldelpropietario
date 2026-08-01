import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './public-data-v3.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/public-data',method:'GET'};
