import {withLambda} from '@netlify/aws-lambda-compat';
import legacy from './condo-autopilot-scheduled.js';

export default withLambda(legacy.handler);
export const config={schedule:'0 4 * * *'};
