'use strict';

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');
const required=[
 'admin-autopilot.js',
 'admin-autopilot.css',
 'config/condo-automation-rules-v1.json',
 'config/smart-payment-schema-v2.json',
 'netlify/functions/condo-autopilot-scheduled.js',
 'netlify/functions/condo-autopilot-background.js',
 'netlify/functions/payment-report-analyzer-background.js',
 'netlify/functions/payment-report-recovery-scheduled.js',
 'netlify/functions/_automation_activation_preflight.js',
 'scripts/expense-lifecycle-backfill.js'
];
const errors=[];
const check=(condition,message)=>{if(!condition)errors.push(message)};

for(const file of required)check(fs.existsSync(path.join(ROOT,file)),`Falta ${file}.`);
for(const file of ['config/condo-automation-rules-v1.json','config/smart-payment-schema-v2.json']){
 try{JSON.parse(read(file))}catch(error){errors.push(`${file}: JSON inválido (${error.message}).`)}
}

const rules=JSON.parse(read('config/condo-automation-rules-v1.json'));
check(rules.masterEnabled===false,'El piloto debe desplegarse apagado.');
check(rules.rulesConfirmed===false,'Las reglas deben desplegarse sin confirmar.');
check(rules.payment.automaticApprovalEnabled===false,'El autopago debe desplegarse apagado.');
check(rules.access.automaticEnabled===false,'El control automático debe desplegarse apagado.');
check(rules.monthlyClose.automaticEnabled===false,'El cierre automático debe desplegarse apagado.');
check(rules.expensePreload.automaticEnabled===false,'La precarga automática debe desplegarse apagada.');

const netlify=read('netlify.toml');
check(netlify.includes('[functions."condo-autopilot-scheduled"]'),'Falta el cron diario del piloto.');
check(netlify.includes('schedule = "0 4 * * *"'),'El cron principal debe equivaler a medianoche de Venezuela.');
check(netlify.includes('[functions."payment-report-recovery-scheduled"]'),'Falta la recuperación horaria de comprobantes.');

const edge=read('netlify/edge-functions/admin-premium-assets.js');
check(edge.includes('admin-autopilot.js')&&edge.includes('admin-autopilot.css'),'El panel administrativo no inyecta el piloto.');
const background=read('netlify/functions/condo-autopilot-background.js');
check(background.includes("require('./_internal_job_auth')")&&background.includes('verify(rawBody'),'El trabajo pesado no está autenticado.');
const recovery=read('netlify/functions/payment-report-recovery-scheduled.js');
new vm.Script(recovery,{filename:'payment-report-recovery-scheduled.js'});

let branch='';
try{branch=execFileSync('git',['branch','--show-current'],{cwd:ROOT,encoding:'utf8'}).trim()}catch(error){errors.push(`No se pudo verificar la rama: ${error.message}.`)}
check(branch&&branch!=='main'&&branch!=='master','La preparación no debe ejecutarse directamente sobre la rama principal.');

let trackedText='';
try{trackedText=execFileSync('git',['diff','--check'],{cwd:ROOT,encoding:'utf8'}).trim()}catch(error){trackedText=String(error.stdout||error.message||'').trim()}
check(!trackedText,`Git detectó errores de espacios o conflictos: ${trackedText}`);
let conflictFiles='';
try{conflictFiles=execFileSync('git',['grep','-l','^<<<<<<<\\|^=======\\|^>>>>>>>','--','.'],{cwd:ROOT,encoding:'utf8'}).trim()}catch(error){if(error.status!==1)errors.push(`No se pudieron buscar conflictos: ${error.message}.`)}
check(!conflictFiles,`Hay marcadores de conflicto en: ${conflictFiles}`);

if(errors.length){
 console.error('PREDEPLOY_CHECK_FAILED');
 for(const error of errors)console.error(`- ${error}`);
 process.exit(1);
}
console.log(JSON.stringify({ok:true,branch,requiredFiles:required.length,safeDefaults:true,schedules:true,internalAuthentication:true}));
