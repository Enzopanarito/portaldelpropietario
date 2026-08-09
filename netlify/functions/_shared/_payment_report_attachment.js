'use strict';

const MAX_ATTACHMENT_BYTES=3*1024*1024;
const ALLOWED_ATTACHMENT_TYPES=new Set(['image/jpeg','image/png','application/pdf']);

function safeFilename(value,type){
  const extension=type==='application/pdf'?'.pdf':type==='image/png'?'.png':'.jpg';
  const base=String(value||'comprobante').normalize('NFKD').replace(/\.[A-Za-z0-9]{1,8}$/,'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,110)||'comprobante';
  return base+extension;
}

function hasExpectedSignature(buffer,type){
  if(type==='image/jpeg')return buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(type==='image/png')return buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if(type==='application/pdf')return buffer.length>=5&&buffer.subarray(0,5).toString('ascii')==='%PDF-';
  return false;
}

function decodeAttachment(input){
  if(!input)return null;
  if(typeof input!=='object')throw new Error('El comprobante adjunto no es válido.');
  const type=String(input.type||'').toLowerCase().trim();
  if(!ALLOWED_ATTACHMENT_TYPES.has(type))throw new Error('El comprobante debe ser JPG, PNG o PDF.');
  const base64=String(input.base64||'').replace(/\s+/g,'');
  if(!base64||base64.length>Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+16)throw new Error('El comprobante está vacío o supera 3 MB.');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw new Error('El comprobante contiene datos inválidos.');
  const content=Buffer.from(base64,'base64');
  if(!content.length||content.length>MAX_ATTACHMENT_BYTES)throw new Error('El comprobante supera el máximo de 3 MB.');
  if(!hasExpectedSignature(content,type))throw new Error('El contenido del comprobante no coincide con su formato.');
  return{filename:safeFilename(input.name,type),content,contentType:type,size:content.length};
}

module.exports={MAX_ATTACHMENT_BYTES,ALLOWED_ATTACHMENT_TYPES,safeFilename,hasExpectedSignature,decodeAttachment};
