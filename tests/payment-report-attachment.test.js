'use strict';
const assert=require('assert');
const {decodeAttachment,MAX_ATTACHMENT_BYTES}=require('../netlify/functions/_payment_report_attachment');

const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.from('test')]);
const decoded=decodeAttachment({name:'comprobante casa 4.png',type:'image/png',base64:png.toString('base64')});
assert.equal(decoded.filename,'comprobante_casa_4.png');
assert.equal(decoded.contentType,'image/png');
assert(decoded.content.equals(png));

assert.throws(()=>decodeAttachment({name:'x.exe',type:'application/octet-stream',base64:'AAAA'}),/JPG, PNG o PDF/);
assert.throws(()=>decodeAttachment({name:'fake.png',type:'image/png',base64:Buffer.from('not png').toString('base64')}),/no coincide/);
assert.throws(()=>decodeAttachment({name:'large.pdf',type:'application/pdf',base64:Buffer.alloc(MAX_ATTACHMENT_BYTES+1).toString('base64')}),/3 MB/);
assert.equal(decodeAttachment(null),null);
console.log('payment-report-attachment: OK');
