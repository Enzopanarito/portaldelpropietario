import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './audit-snapshot.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/audit-snapshot',method:'POST'};
