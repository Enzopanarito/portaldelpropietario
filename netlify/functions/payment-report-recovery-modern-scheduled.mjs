import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './payment-report-recovery-scheduled.js';

export default withLambda(legacy.handler);
export const config={schedule:'15 * * * *'};
