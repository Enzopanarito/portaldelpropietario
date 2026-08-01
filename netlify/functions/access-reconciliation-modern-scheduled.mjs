import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './access-reconciliation-scheduled.js';

export default withLambda(legacy.handler);
export const config={schedule:'5 * * * *'};
