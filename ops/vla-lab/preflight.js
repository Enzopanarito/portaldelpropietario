'use strict';
const fs=require('fs');
const path=require('path');
const {execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..','..');
const STAGING='appZhq8nVZ7lZ2k6K';
const PRODUCTION='app4nE4ReGRi2SuP2';
function fail(message){console.error(`VLA_LAB_PREFLIGHT_FAIL ${message}`);process.exit(1)}
const toml=fs.readFileSync(path.join(ROOT,'netlify.toml'),'utf8');
for(const required of ['VLA_LAB_MODE = "true"',`AIRTABLE_BASE_ID = "${STAGING}"`,'VLA_DATA_ENVIRONMENT = "staging"','VLA_WHATSAPP_CONTROL_URL = "disabled://vla-lab"','MKJ_BASE_URL = "http://127.0.0.1:9"'])if(!toml.includes(required))fail(`Falta protección ${required}`);
const devBlock=(toml.match(/\[context\.dev\.environment\]([\s\S]*?)(?=\n\[|\n# \w|$)/)||[])[1]||'';
if(devBlock.includes(PRODUCTION))fail('La base productiva aparece dentro del contexto dev.');
const staging=JSON.parse(fs.readFileSync(path.join(ROOT,'config','smart-payment-staging-v2.json'),'utf8'));
if(staging.baseId!==STAGING||staging.environment!=='staging')fail('El manifiesto staging no coincide con la base aislada.');
if(staging.automaticActionsEnabled!==false)fail('Staging no puede habilitar acciones automáticas.');
if(staging.tables?.Propietarios?.expectedRecords!==15)fail('El LAB debe conservar las 15 casas ficticias.');
if(staging.tables?.['Cuentas de Cobro Autorizadas']?.expectedRecords!==6)fail('El LAB debe tener seis receptores de prueba configurados.');
let branch='';try{branch=execFileSync('git',['branch','--show-current'],{cwd:ROOT,encoding:'utf8'}).trim()}catch(_){}
if(branch==='main')console.warn('VLA_LAB_PREFLIGHT_WARN Estás en main. El entorno dev sigue aislado, pero para estas pruebas usa la rama de laboratorio.');
console.log(JSON.stringify({ok:true,lab:true,branch:branch||'desconocida',stagingBase:STAGING,houses:15,authorizedRecipients:6,automaticActions:false,whatsappReal:false,mkjReal:false,smtpReal:false}));
