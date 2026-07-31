'use strict';

function present(value){return String(value??'').trim().length>0}
function checkAutomationActivation({rules,env=process.env}={}){
 const checks=[],blockers=[];
 const add=(code,ok,detail)=>{const item={code,ok:Boolean(ok),detail};checks.push(item);if(!ok)blockers.push(item)};
 const requested=rules?.masterEnabled===true;
 add('JOB_AUTH',!requested||present(env.AUTOMATION_JOB_SECRET||env.ADMIN_TOKEN_SECRET||env.ADMIN_PASSWORD),'El piloto requiere un secreto interno.');
 add('SITE_URL',!requested||/^https:\/\//.test(String(env.URL||'')),'El piloto requiere la URL HTTPS de producción.');
 const notifications=requested&&rules?.notifications?.automaticEnabled===true;
 add('SMTP',!notifications||[env.SMTP_HOST,env.SMTP_USER,env.SMTP_SECRET].every(present),'Los avisos automáticos requieren SMTP completo.');
 const access=requested&&rules?.access?.automaticEnabled===true;
 add('MKJ',!access||[env.MKJ_ORG_ID,env.MKJ_ADMIN_EMAIL,env.MKJ_ADMIN_PASSWORD].every(present),'El control automático requiere las credenciales MKJoules.');
 add('AIRTABLE',!requested||[env.AIRTABLE_API_TOKEN,env.AIRTABLE_BASE_ID].every(present),'El piloto requiere Airtable configurado.');
 return{ok:blockers.length===0,requested,checks,blockers};
}

module.exports={present,checkAutomationActivation};
