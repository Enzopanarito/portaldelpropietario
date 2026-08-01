import {withLambda} from '@netlify/aws-lambda-compat';
import 'nodemailer';
import legacy from './access-reconciliation-background.js';

export default withLambda(legacy.handler);
export const config={path:'/api/vla/access-reconciliation',method:'POST',background:true};
