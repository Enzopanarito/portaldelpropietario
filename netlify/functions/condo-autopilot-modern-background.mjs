import 'nodemailer';
import legacy from './condo-autopilot-background.js';
import {invokeLegacy} from './_shared/legacy-function-bridge.mjs';

export default async (request,context)=>{
  try {
    const response=await invokeLegacy(request,context,legacy.handler);
    const body=await response.clone().json().catch(()=>({}));
    console.log(JSON.stringify({event:'VLA_AUTOPILOT_RESULT',status:response.status,success:body.success===true,reason:body.reason||null,message:body.message||null,detail:body.detail||null,close:body.actions?.monthlyClose?.success===true,blockers:body.actions?.monthlyClose?.blockers||body.actions?.monthlyClose?.preflight?.blockers||[],heartbeat:body.heartbeat||null}));
    if(response.status>=500)throw new Error('VLA_AUTOPILOT_FAILED');
    return response;
  } catch(error) {
    console.error(JSON.stringify({event:'VLA_AUTOPILOT_EXCEPTION',name:error?.name||'Error',message:String(error?.message||error).slice(0,500)}));
    throw error;
  }
};
export const config={path:'/api/vla/condo-autopilot',method:'POST',background:true};
