'use strict';

const assert=require('assert');
const core=require('../netlify/functions/_payment_proof_core');

function png(width=1200,height=900,{complete=true}={}){
 const signature=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
 const ihdr=Buffer.alloc(25);ihdr.writeUInt32BE(13,0);ihdr.write('IHDR',4,'ascii');ihdr.writeUInt32BE(width,8);ihdr.writeUInt32BE(height,12);ihdr[16]=8;ihdr[17]=2;
 const end=complete?Buffer.from([0,0,0,0,0x49,0x45,0x4e,0x44,0,0,0,0]):Buffer.alloc(0);
 return Buffer.concat([signature,ihdr,Buffer.alloc(Math.max(128,Math.round(width*height*0.02))),end]);
}
function jpeg(width=1200,height=900,{complete=true}={}){
 const soi=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10]);
 const app=Buffer.alloc(14);
 const sof=Buffer.alloc(19);sof[0]=0xff;sof[1]=0xc0;sof.writeUInt16BE(17,2);sof[4]=8;sof.writeUInt16BE(height,5);sof.writeUInt16BE(width,7);sof[9]=3;
 const data=Buffer.alloc(256,0xaa),eoi=complete?Buffer.from([0xff,0xd9]):Buffer.alloc(0);
 return Buffer.concat([soi,app,sof,data,eoi]);
}
function webp(width=1200,height=900,{complete=true}={}){
 const body=Buffer.alloc(22);body.write('VP8X',0,'ascii');body.writeUInt32LE(10,4);const w=width-1,h=height-1;body[12]=w&255;body[13]=(w>>8)&255;body[14]=(w>>16)&255;body[15]=h&255;body[16]=(h>>8)&255;body[17]=(h>>16)&255;
 const result=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WEBP'),body]);result.writeUInt32LE((complete?result.length:result.length+100)-8,4);return result;
}
function pdf(complete=true){return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${complete?'%%EOF':''}`,'ascii')}
function heic(){const buffer=Buffer.alloc(32);buffer.writeUInt32BE(24,0);buffer.write('ftyp',4,'ascii');buffer.write('heic',8,'ascii');return buffer}
function input(name,type,content){return{name,type,base64:content.toString('base64')}}

(()=>{
 const p=core.decodeProofInput(input('captura.PNG','image/png',png()));
 assert.strictEqual(p.format,'png');assert.strictEqual(p.filename,'captura.png');assert.deepStrictEqual(p.dimensions,{width:1200,height:900});assert.strictEqual(p.quality.acceptable,true);assert.match(p.sha256,/^[a-f0-9]{64}$/);
 const j=core.decodeProofInput(input('../Banco extraño.jpeg','image/jpeg',jpeg()));assert.strictEqual(j.format,'jpeg');assert.deepStrictEqual(j.dimensions,{width:1200,height:900});assert(!j.filename.includes('..'));
 const w=core.decodeProofInput(input('pago.webp','image/webp',webp()));assert.deepStrictEqual(w.dimensions,{width:1200,height:900});
 const document=core.decodeProofInput(input('transferencia.pdf','application/pdf',pdf()));assert.strictEqual(document.pdfImageExtractionCandidate,true);assert(document.quality.warnings.includes('CONVERSION_REQUIRED'));
 const iphone=core.decodeProofInput(input('IMG_0001.HEIC','image/heic',heic()));assert.strictEqual(iphone.requiresConversion,true);assert.strictEqual(iphone.format,'heic');

 const low=core.decodeProofInput(input('small.png','image/png',png(200,500)));assert.strictEqual(low.quality.acceptable,false);assert.strictEqual(low.quality.reason,'RESOLUTION_TOO_LOW');
 const truncatedPng=core.decodeProofInput(input('cut.png','image/png',png(900,900,{complete:false})));assert.strictEqual(truncatedPng.quality.reason,'TRUNCATED_FILE');
 const truncatedJpeg=core.decodeProofInput(input('cut.jpg','image/jpeg',jpeg(900,900,{complete:false})));assert.strictEqual(truncatedJpeg.quality.reason,'TRUNCATED_FILE');
 const truncatedWebp=core.decodeProofInput(input('cut.webp','image/webp',webp(900,900,{complete:false})));assert.strictEqual(truncatedWebp.quality.reason,'TRUNCATED_FILE');
 const truncatedPdf=core.decodeProofInput(input('cut.pdf','application/pdf',pdf(false)));assert.strictEqual(truncatedPdf.quality.reason,'TRUNCATED_FILE');

 assert.throws(()=>core.decodeProofInput(input('fake.jpg','image/jpeg',png())),error=>error.code==='MIME_SIGNATURE_MISMATCH');
 assert.throws(()=>core.decodeProofInput({name:'x.gif',type:'image/gif',base64:'AAAA'}),error=>error.code==='UNSUPPORTED_ATTACHMENT_TYPE');
 assert.throws(()=>core.decodeBase64Strict('***'),error=>error.code==='INVALID_BASE64');
 assert.throws(()=>core.decodeProofInput({name:'big.png',type:'image/png',content:Buffer.alloc(core.DEFAULT_MAX_BYTES+1)}),error=>error.code==='MIME_SIGNATURE_MISMATCH'||error.code==='ATTACHMENT_TOO_LARGE');
 const a=core.decodeProofInput(input('a.png','image/png',png())),b=core.decodeProofInput(input('renamed.png','image/png',png()));assert.strictEqual(a.sha256,b.sha256,'Renombrar el archivo no cambia el hash exacto.');
 assert.strictEqual(core.buildIdempotencyKey('rec123',a.sha256,'PROMPT_V2'),`rec123|${a.sha256}|PROMPT_V2`);
 assert.throws(()=>core.buildIdempotencyKey('',a.sha256,'PROMPT_V2'));
 console.log('PAYMENT_PROOF_CORE_OK');
})();
