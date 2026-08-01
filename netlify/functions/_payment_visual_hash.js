'use strict';

const {dHashFromGrayscale,normalizeVisualHash}=require('./_payment_duplicate_core');

const SUPPORTED_TYPES=new Set(['image/jpeg','image/png','image/webp']);

function clean(value){return String(value??'').trim().toLowerCase()}
function codedError(message,code,extra={}){return Object.assign(new Error(message),{code,...extra})}

async function defaultSharpFactory(content){
 const sharp=require('sharp');
 return sharp(content,{failOn:'error',limitInputPixels:40_000_000,sequentialRead:true});
}

async function computePerceptualHash(content,contentType,{sharpFactory=defaultSharpFactory}={}){
 const type=clean(contentType);
 if(!Buffer.isBuffer(content)||!content.length)throw codedError('El comprobante visual está vacío.','VISUAL_HASH_EMPTY');
 if(!SUPPORTED_TYPES.has(type))return{supported:false,hash:'',algorithm:'none',reason:'UNSUPPORTED_VISUAL_TYPE'};
 try{
  const pipeline=await sharpFactory(content);
  const {data,info}=await pipeline.rotate().resize(9,8,{fit:'fill',kernel:'lanczos3'}).grayscale().removeAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.width!==9||info.height!==8||info.channels!==1||data.length!==72)throw codedError('No se obtuvo la matriz visual esperada.','VISUAL_HASH_MATRIX_INVALID',{info});
  const hash=dHashFromGrayscale([...data],9,8);
  if(!normalizeVisualHash(hash))throw codedError('La huella visual calculada no es válida.','VISUAL_HASH_INVALID');
  return{supported:true,hash,algorithm:'dhash-64-v1',width:info.width,height:info.height};
 }catch(error){
  if(error?.code&&String(error.code).startsWith('VISUAL_HASH_'))throw error;
  throw codedError('No se pudo calcular la huella visual del comprobante.','VISUAL_HASH_FAILED',{cause:error});
 }
}

module.exports={SUPPORTED_TYPES,clean,codedError,defaultSharpFactory,computePerceptualHash};
