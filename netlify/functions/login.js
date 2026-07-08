// netlify/functions/login.js

const crypto = require('crypto');
const { issueAdminToken } = require('./_auth');

const TABLE = 'ControlVersiones';
const CONFIG_PREFIX = 'ADMIN_AUTH_CONFIG|';
let authCache = null;
const AUTH_CACHE_TTL_MS = 2 * 60 * 1000;

function json(statusCode, body){return{statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function url(path=''){return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${path}`}
function unb64url(str){return Buffer.from(str,'base64url').toString('utf8')}
function hashPassword(password,salt){return crypto.pbkdf2Sync(String(password||''),salt,120000,32,'sha256').toString('hex')}
function safeParse(record){
  const key=record?.fields?.Key||'';
  if(!key.startsWith(CONFIG_PREFIX))return null;
  try{return JSON.parse(unb64url(key.slice(CONFIG_PREFIX.length)))}catch{return null}
}
async function getConfig(){
  if(authCache&&authCache.expiresAt>Date.now())return authCache.config;
  if(!process.env.AIRTABLE_API_TOKEN||!process.env.AIRTABLE_BASE_ID)return null;
  try{
    const formula=encodeURIComponent(`LEFT({Key}, ${CONFIG_PREFIX.length})='${CONFIG_PREFIX}'`);
    const res=await fetch(url(`?filterByFormula=${formula}&maxRecords=1`),{headers:{Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`}});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)return null;
    const config=safeParse(data.records?.[0]);
    authCache={config,expiresAt:Date.now()+AUTH_CACHE_TTL_MS};
    return config;
  }catch{return null}
}
function verify(password,config){
  if(config?.passwordHash&&config?.salt)return hashPassword(password,config.salt)===config.passwordHash;
  return process.env.ADMIN_PASSWORD && password===process.env.ADMIN_PASSWORD;
}
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return json(405,{ message: 'Method Not Allowed' });
  try {
    const { password } = JSON.parse(event.body || '{}');
    const config = await getConfig();
    if (!config?.passwordHash && !process.env.ADMIN_PASSWORD) return json(500,{ message: 'La contraseña de administrador no está configurada en el servidor.' });
    if (verify(password, config)) {
      const token = issueAdminToken();
      return json(200,{ success: true, token, expiresInHours: 12, source: config?.passwordHash ? 'secure-config' : 'environment' });
    }
    return json(401,{ success: false, message: 'Contraseña incorrecta.' });
  } catch (error) {
    return json(500,{ message: 'Error en el servidor.' });
  }
};
