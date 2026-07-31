'use strict';

const HASH_PATTERN=/^[a-f0-9]{64}$/;

function certifiedHash(name){return HASH_PATTERN.test(String(process.env[name]||'').trim().toLowerCase());}
function backupCertified(){return certifiedHash('WHATSAPP_BACKUP_CERTIFIED_SHA256');}
function connectorCertified(){return certifiedHash('WHATSAPP_CONNECTOR_CERTIFIED_SHA256');}
function queueEnabled(){return process.env.WHATSAPP_QUEUE_ENABLED==='true'&&backupCertified();}
function connectorEnabled(){return process.env.WHATSAPP_CONNECTOR_ENABLED==='true'&&backupCertified()&&connectorCertified();}
function realSendEnabled(){return process.env.WHATSAPP_REAL_SEND_ENABLED==='true'&&connectorEnabled();}
function publicStatus(){return{backupCertified:backupCertified(),connectorCertified:connectorCertified(),queueEnabled:queueEnabled(),connectorEnabled:connectorEnabled(),realSendEnabled:realSendEnabled()};}
function requireQueue(){
  if(process.env.WHATSAPP_QUEUE_ENABLED!=='true')throw new Error('La cola permanece desactivada por el servidor.');
  if(!backupCertified())throw new Error('La cola no puede activarse sin el SHA-256 del respaldo operativo certificado.');
}
function requireConnector(){
  requireQueue();
  if(process.env.WHATSAPP_CONNECTOR_ENABLED!=='true')throw new Error('El conector local permanece desactivado por el servidor.');
  if(!connectorCertified())throw new Error('El conector no puede activarse sin un artefacto Mac certificado por SHA-256.');
}
function requireRealSend(){
  requireConnector();
  if(process.env.WHATSAPP_REAL_SEND_ENABLED!=='true')throw new Error('El envío real permanece bloqueado.');
}

module.exports={HASH_PATTERN,certifiedHash,backupCertified,connectorCertified,queueEnabled,connectorEnabled,realSendEnabled,publicStatus,requireQueue,requireConnector,requireRealSend};
