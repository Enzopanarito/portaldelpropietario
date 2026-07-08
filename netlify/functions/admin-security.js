// netlify/functions/admin-security.js
// Cambio y recuperación de contraseña admin usando hashes en ControlVersiones.

const crypto = require('crypto');
const { requireAdmin } = require('./_auth');

const TABLE = 'ControlVersiones';
const CONFIG_PREFIX = 'ADMIN_AUTH_CONFIG|';
const RECOVERY_EMAIL = process.env.ADMIN_RECOVERY_EMAIL || 'enzopanarito@gmail.com';

function json(statusCode, body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function url(table,path=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}${path}`}
async function airtable(table,options={},path=''){
  const res=await fetch(url(table,path),{...options,headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error?.message||data.message||`Error Airtable ${table}`);
  return data;
}
function b64url(str){return Buffer.from(str,'utf8').toString('base64url')}
function unb64url(str){return Buffer.from(str,'base64url').toString('utf8')}
function hashPassword(password,salt){return crypto.pbkdf2Sync(String(password||''),salt,120000,32,'sha256').toString('hex')}
function tokenHash(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}
function makeSalt(){return crypto.randomBytes(16).toString('hex')}
function makeToken(){return crypto.randomBytes(32).toString('base64url')}
function safeParseConfig(record){
  if(!record)return null;
  const key=record.fields?.Key||'';
  if(!key.startsWith(CONFIG_PREFIX))return null;
  try{return JSON.parse(unb64url(key.slice(CONFIG_PREFIX.length)))}catch{return null}
}
async function getConfigRecord(){
  const formula=encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
  const data=await airtable(TABLE,{},`?filterByFormula=${formula}&maxRecords=1`);
  const record=data.records?.[0]||null;
  return {record,config:safeParseConfig(record)};
}
async function saveConfig(config,recordId){
  const fields={Key:CONFIG_PREFIX+b64url(JSON.stringify(config)),Version:Number(config.version||1)};
  if(recordId){return airtable(TABLE,{method:'PATCH',body:JSON.stringify({records:[{id:recordId,fields}],typecast:true})});}
  return airtable(TABLE,{method:'POST',body:JSON.stringify({records:[{fields}],typecast:true})});
}
function verify(password,config){
  if(config?.passwordHash&&config?.salt){return hashPassword(password,config.salt)===config.passwordHash;}
  return process.env.ADMIN_PASSWORD && password===process.env.ADMIN_PASSWORD;
}
async function sendRecoveryEmail(email,link){
  const apiKey=process.env.RESEND_API_KEY;
  const from=process.env.MAIL_FROM||process.env.RECEIPTS_FROM_EMAIL;
  if(!apiKey||!from)return {sent:false,detail:'Faltan RESEND_API_KEY y/o MAIL_FROM en Netlify.'};
  const html=`<p>Solicitaste recuperar la contraseña del Portal Admin de Villa Los Apamates.</p><p><a href="${link}">Haz clic aquí para crear una nueva contraseña</a></p><p>Este enlace expira en 15 minutos.</p>`;
  const res=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:email,subject:'Recuperación de contraseña - Villa Los Apamates',html})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)return {sent:false,detail:data.message||JSON.stringify(data)};
  return {sent:true,detail:data.id||'Enviado'};
}
exports.handler=async function(event){
  try{
    if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return json(500,{message:'Airtable no está configurado.'});
    const body=JSON.parse(event.body||'{}');
    const action=body.action||'';

    if(action==='changePassword'){
      const auth=requireAdmin(event); if(!auth.ok)return auth.response;
      if(!body.currentPassword||!body.newPassword||String(body.newPassword).length<8)return json(400,{message:'Ingrese contraseña actual y una nueva contraseña de mínimo 8 caracteres.'});
      const {record,config}=await getConfigRecord();
      if(!verify(body.currentPassword,config))return json(401,{message:'La contraseña actual no es correcta.'});
      const salt=makeSalt();
      const newConfig={...(config||{}),version:Number(config?.version||0)+1,recoveryEmail:RECOVERY_EMAIL,salt,passwordHash:hashPassword(body.newPassword,salt),updatedAt:new Date().toISOString(),resetHash:null,resetExpires:null};
      await saveConfig(newConfig,record?.id);
      return json(200,{success:true,message:'Contraseña actualizada.'});
    }

    if(action==='requestReset'){
      const email=String(body.email||'').trim().toLowerCase();
      if(email!==RECOVERY_EMAIL.toLowerCase())return json(200,{success:true,message:'Si el correo está autorizado, recibirá instrucciones.'});
      const {record,config}=await getConfigRecord();
      const token=makeToken();
      const expires=new Date(Date.now()+15*60*1000).toISOString();
      const newConfig={...(config||{}),version:Number(config?.version||0)+1,recoveryEmail:RECOVERY_EMAIL,resetHash:tokenHash(token),resetExpires:expires,updatedAt:new Date().toISOString()};
      await saveConfig(newConfig,record?.id);
      const origin=(event.headers.origin||process.env.URL||'https://villalosapamates.netlify.app').replace(/\/$/,'');
      const link=`${origin}/seguridad.html?reset=${encodeURIComponent(token)}`;
      const sent=await sendRecoveryEmail(RECOVERY_EMAIL,link);
      return json(200,{success:true,emailSent:sent.sent,message:sent.sent?'Correo de recuperación enviado.':'Recuperación preparada, pero falta configurar proveedor de correo en Netlify.',detail:sent.detail});
    }

    if(action==='resetPassword'){
      if(!body.token||!body.newPassword||String(body.newPassword).length<8)return json(400,{message:'Token y nueva contraseña son obligatorios. Mínimo 8 caracteres.'});
      const {record,config}=await getConfigRecord();
      if(!config?.resetHash||!config?.resetExpires)return json(400,{message:'No hay solicitud de recuperación activa.'});
      if(new Date(config.resetExpires).getTime()<Date.now())return json(400,{message:'El enlace de recuperación expiró.'});
      if(tokenHash(body.token)!==config.resetHash)return json(400,{message:'Token inválido.'});
      const salt=makeSalt();
      const newConfig={...config,version:Number(config?.version||0)+1,recoveryEmail:RECOVERY_EMAIL,salt,passwordHash:hashPassword(body.newPassword,salt),updatedAt:new Date().toISOString(),resetHash:null,resetExpires:null};
      await saveConfig(newConfig,record?.id);
      return json(200,{success:true,message:'Contraseña restablecida.'});
    }

    return json(400,{message:'Acción no reconocida.'});
  }catch(error){
    return json(500,{message:'Error en seguridad admin.',detail:error.message});
  }
};
