'use strict';

const crypto=require('crypto');

const DEFAULT_MAX_BYTES=8*1024*1024;
const MIN_HARD_DIMENSION=320;
const MIN_RECOMMENDED_DIMENSION=720;
const ALLOWED_TYPES=new Set(['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']);
const FORMAT_BY_TYPE=Object.freeze({'image/jpeg':'jpeg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif','application/pdf':'pdf'});

function clean(value){return String(value??'').trim()}
function sha256(buffer){return crypto.createHash('sha256').update(buffer).digest('hex')}
function safeFilename(value,type){
 const extension={jpeg:'.jpg',png:'.png',webp:'.webp',heic:'.heic',heif:'.heif',pdf:'.pdf'}[FORMAT_BY_TYPE[type]]||'.bin';
 const base=clean(value||'comprobante').normalize('NFKD').replace(/\.[A-Za-z0-9]{1,10}$/,'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,100)||'comprobante';
 return`${base}${extension}`;
}
function decodeBase64Strict(value,maxBytes=DEFAULT_MAX_BYTES){
 const base64=clean(value).replace(/\s+/g,'');
 if(!base64)throw Object.assign(new Error('El comprobante está vacío.'),{code:'EMPTY_ATTACHMENT'});
 if(base64.length>Math.ceil(maxBytes*4/3)+32)throw Object.assign(new Error('El comprobante supera el tamaño permitido.'),{code:'ATTACHMENT_TOO_LARGE'});
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)||base64.length%4===1)throw Object.assign(new Error('El comprobante contiene una codificación inválida.'),{code:'INVALID_BASE64'});
 const buffer=Buffer.from(base64,'base64');
 if(!buffer.length)throw Object.assign(new Error('El comprobante está vacío.'),{code:'EMPTY_ATTACHMENT'});
 if(buffer.length>maxBytes)throw Object.assign(new Error('El comprobante supera el tamaño permitido.'),{code:'ATTACHMENT_TOO_LARGE'});
 return buffer;
}
function isoBrand(buffer){return buffer.length>=12&&buffer.subarray(4,8).toString('ascii')==='ftyp'?buffer.subarray(8,12).toString('ascii'):''}
function detectFormat(buffer){
 if(!Buffer.isBuffer(buffer)||!buffer.length)return null;
 if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return'jpeg';
 if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return'png';
 if(buffer.length>=12&&buffer.subarray(0,4).toString('ascii')==='RIFF'&&buffer.subarray(8,12).toString('ascii')==='WEBP')return'webp';
 if(buffer.length>=5&&buffer.subarray(0,5).toString('ascii')==='%PDF-')return'pdf';
 const brand=isoBrand(buffer);if(['heic','heix','hevc','hevx','heim','heis'].includes(brand))return'heic';if(['mif1','msf1'].includes(brand))return'heif';
 return null;
}
function expectedFormat(type){return FORMAT_BY_TYPE[clean(type).toLowerCase()]||null}
function hasPdfEof(buffer){return buffer.subarray(Math.max(0,buffer.length-2048)).includes(Buffer.from('%%EOF'))}
function hasPngEnd(buffer){return buffer.length>=20&&buffer.subarray(Math.max(0,buffer.length-32)).includes(Buffer.from('IEND'))}
function isTruncated(buffer,format){
 if(format==='jpeg')return buffer.length<4||buffer[buffer.length-2]!==0xff||buffer[buffer.length-1]!==0xd9;
 if(format==='png')return!hasPngEnd(buffer);
 if(format==='pdf')return!hasPdfEof(buffer);
 if(format==='webp'){const declared=buffer.readUInt32LE(4)+8;return declared>buffer.length||buffer.length<20}
 return false;
}
function pngDimensions(buffer){if(buffer.length<24||buffer.subarray(12,16).toString('ascii')!=='IHDR')return null;return{width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}}
function jpegDimensions(buffer){
 let offset=2;
 while(offset+9<buffer.length){if(buffer[offset]!==0xff){offset+=1;continue}while(buffer[offset]===0xff)offset+=1;const marker=buffer[offset++];if(marker===0xd8||marker===0xd9)continue;if(offset+2>buffer.length)break;const length=buffer.readUInt16BE(offset);if(length<2||offset+length>buffer.length)break;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return{height:buffer.readUInt16BE(offset+3),width:buffer.readUInt16BE(offset+5)};
  offset+=length;
 }
 return null;
}
function readUInt24LE(buffer,offset){return buffer[offset]|(buffer[offset+1]<<8)|(buffer[offset+2]<<16)}
function webpDimensions(buffer){
 if(buffer.length<30)return null;const chunk=buffer.subarray(12,16).toString('ascii');
 if(chunk==='VP8X'&&buffer.length>=30)return{width:readUInt24LE(buffer,24)+1,height:readUInt24LE(buffer,27)+1};
 if(chunk==='VP8L'&&buffer.length>=25&&buffer[20]===0x2f){const b1=buffer[21],b2=buffer[22],b3=buffer[23],b4=buffer[24];return{width:1+(((b2&0x3f)<<8)|b1),height:1+(((b4&0x0f)<<10)|(b3<<2)|((b2&0xc0)>>6))}}
 if(chunk==='VP8 '&&buffer.length>=30&&buffer[23]===0x9d&&buffer[24]===0x01&&buffer[25]===0x2a)return{width:buffer.readUInt16LE(26)&0x3fff,height:buffer.readUInt16LE(28)&0x3fff};
 return null;
}
function imageDimensions(buffer,format){if(format==='png')return pngDimensions(buffer);if(format==='jpeg')return jpegDimensions(buffer);if(format==='webp')return webpDimensions(buffer);return null}
function preliminaryQuality(buffer,format,dimensions){
 const warnings=[];let acceptable=true,reason='';
 if(isTruncated(buffer,format)){acceptable=false;reason='TRUNCATED_FILE'}
 if(dimensions){const min=Math.min(dimensions.width,dimensions.height),pixels=dimensions.width*dimensions.height;if(min<MIN_HARD_DIMENSION){acceptable=false;reason=reason||'RESOLUTION_TOO_LOW'}else if(min<MIN_RECOMMENDED_DIMENSION)warnings.push('LOW_RESOLUTION');if(pixels>0&&buffer.length/pixels<0.01)warnings.push('EXTREME_COMPRESSION')}
 else if(['jpeg','png','webp'].includes(format)){acceptable=false;reason=reason||'DIMENSIONS_UNREADABLE'}
 if(['heic','heif','pdf'].includes(format))warnings.push('CONVERSION_REQUIRED');
 return{acceptable,reason,warnings,requiresPixelAnalysis:['jpeg','png','webp','heic','heif'].includes(format)};
}
function decodeProofInput(input,{maxBytes=DEFAULT_MAX_BYTES}={}){
 if(!input||typeof input!=='object')throw Object.assign(new Error('El comprobante adjunto no es válido.'),{code:'INVALID_ATTACHMENT'});
 const declaredType=clean(input.type).toLowerCase();if(!ALLOWED_TYPES.has(declaredType))throw Object.assign(new Error('El comprobante debe ser JPG, PNG, WebP, HEIC o PDF.'),{code:'UNSUPPORTED_ATTACHMENT_TYPE'});
 const content=Buffer.isBuffer(input.content)?Buffer.from(input.content):decodeBase64Strict(input.base64,maxBytes);
 if(!content.length)throw Object.assign(new Error('El comprobante está vacío.'),{code:'EMPTY_ATTACHMENT'});
 if(content.length>maxBytes)throw Object.assign(new Error('El comprobante supera el tamaño permitido.'),{code:'ATTACHMENT_TOO_LARGE'});
 const format=detectFormat(content),expected=expectedFormat(declaredType);if(!format||format!==expected)throw Object.assign(new Error('El contenido del comprobante no coincide con el formato declarado.'),{code:'MIME_SIGNATURE_MISMATCH',detectedFormat:format,expectedFormat:expected});
 const dimensions=imageDimensions(content,format),quality=preliminaryQuality(content,format,dimensions);
 return{filename:safeFilename(input.name,declaredType),originalName:clean(input.name||'comprobante'),content,contentType:declaredType,format,size:content.length,sha256:sha256(content),dimensions,quality,requiresConversion:['heic','heif'].includes(format),pdfImageExtractionCandidate:format==='pdf'};
}
function buildIdempotencyKey(reportId,attachmentSha,promptVersion){for(const[name,value]of Object.entries({reportId,attachmentSha,promptVersion}))if(!clean(value))throw new Error(`Falta ${name}.`);return`${clean(reportId)}|${clean(attachmentSha).toLowerCase()}|${clean(promptVersion)}`}

module.exports={DEFAULT_MAX_BYTES,MIN_HARD_DIMENSION,MIN_RECOMMENDED_DIMENSION,ALLOWED_TYPES,FORMAT_BY_TYPE,clean,sha256,safeFilename,decodeBase64Strict,detectFormat,expectedFormat,isTruncated,pngDimensions,jpegDimensions,webpDimensions,imageDimensions,preliminaryQuality,decodeProofInput,buildIdempotencyKey};
