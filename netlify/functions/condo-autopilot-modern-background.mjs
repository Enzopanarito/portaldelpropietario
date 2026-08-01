import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import legacy from './condo-autopilot-background.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/condo-autopilot',method:'POST',background:true};
