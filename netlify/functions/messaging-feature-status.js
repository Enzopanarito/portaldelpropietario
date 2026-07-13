'use strict';

const { requireAdmin }=require('./_auth');
const gates=require('./_messaging_feature_gates');

const HEADERS={'Content-Type':'application/json','Cache-Control':'no-store, no-cache, must-revalidate','X-Content-Type-Options':'nosniff','X-VLA-Messaging-Gates':'v1'};
exports.handler=async function handler(event){
  const auth=requireAdmin(event);if(!auth.ok)return auth.response;
  if(event.httpMethod!=='GET')return{statusCode:405,headers:HEADERS,body:JSON.stringify({message:'Method Not Allowed'})};
  return{statusCode:200,headers:HEADERS,body:JSON.stringify({...gates.publicStatus(),required:{backupHash:'WHATSAPP_BACKUP_CERTIFIED_SHA256',connectorHash:'WHATSAPP_CONNECTOR_CERTIFIED_SHA256'},serverTime:new Date().toISOString()})};
};
