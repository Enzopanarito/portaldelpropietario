'use strict';

function present(value){return String(value??'').trim().length>0}
function checkAutomationActivation({rules,env=process.env,strictReadiness=false}={}){
 const checks=[],blockers=[];
 const add=(code,ok,detail)=>{const item={code,ok:Boolean(ok),detail};checks.push(item);if(!ok)blockers.push(item)};
 const requested=strictReadiness||rules?.masterEnabled===true;
 add('JOB_AUTH',!requested||(strictReadiness?present(env.AUTOMATION_JOB_SECRET):present(env.AUTOMATION_JOB_SECRET||env.ADMIN_TOKEN_SECRET||env.ADMIN_PASSWORD)),strictReadiness?'El piloto requiere AUTOMATION_JOB_SECRET dedicada.':'El piloto requiere un secreto interno.');
 add('SITE_URL',!requested||/^https:\/\//.test(String(env.URL||'')),'El piloto requiere la URL HTTPS de producción.');
 const notifications=requested&&(strictReadiness||rules?.notifications?.automaticEnabled===true);
 add('SMTP',!notifications||[env.SMTP_HOST,env.SMTP_USER,env.SMTP_SECRET].every(present),'Los avisos automáticos requieren SMTP completo.');
 add('ADMIN_NOTIFY_EMAIL',!notifications||present(env.ADMIN_NOTIFY_EMAIL),'Los avisos requieren un correo administrativo explícito.');
 const access=requested&&(strictReadiness||rules?.access?.automaticEnabled===true);
 add('MKJ',!access||[env.MKJ_ORG_ID,env.MKJ_ADMIN_EMAIL,env.MKJ_ADMIN_PASSWORD].every(present),'El control automático requiere las credenciales MKJoules.');
 add('ACCESS_REQUIRES_CLOSE',!access||rules?.monthlyClose?.automaticEnabled===true,'El portón automático requiere el cierre mensual automático para separar deuda vencida y cuota nueva.');
 add('ACCESS_MONTH_BOUNDARY',!access||(rules?.access?.restrictionDay===1&&rules?.access?.onlyExpiredDebt===true),'El portón debe limitar el día 1 y únicamente por deuda anterior vencida.');
 add('AIRTABLE',!requested||[env.AIRTABLE_API_TOKEN,env.AIRTABLE_BASE_ID].every(present),'El piloto requiere Airtable configurado.');
 return{ok:blockers.length===0,requested,strictReadiness,checks,blockers};
}

module.exports={present,checkAutomationActivation};
