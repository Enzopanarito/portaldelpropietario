'use strict';

const assert = require('assert');
const path = require('path');

const utils = require(path.join(__dirname, '..', 'netlify', 'functions', '_security_utils'));

assert.strictEqual(utils.escapeHtml(`<img src=x onerror="alert('x')">`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;');
assert.strictEqual(utils.sanitizeReference('  TRANSF <script> 123  '), 'TRANSF script 123');
assert.strictEqual(utils.deepEscapeStrings({ name: 'A&B', nested: ['<b>hola</b>'] }).name, 'A&amp;B');
assert.strictEqual(utils.deepEscapeStrings({ nested: ['<b>hola</b>'] }).nested[0], '&lt;b&gt;hola&lt;/b&gt;');

class MemoryStore {
  constructor(){this.map=new Map();this.seq=0;}
  async getWithMetadata(key){const entry=this.map.get(key);return entry?{data:JSON.parse(JSON.stringify(entry.data)),etag:entry.etag,metadata:entry.metadata}:null;}
  async setJSON(key,data,options={}){
    const current=this.map.get(key);
    if(options.onlyIfNew&&current)return{modified:false,etag:current.etag};
    if(options.onlyIfMatch&&(!current||current.etag!==options.onlyIfMatch))return{modified:false,etag:current&&current.etag};
    const etag=`etag-${++this.seq}`;
    this.map.set(key,{data:JSON.parse(JSON.stringify(data)),etag,metadata:options.metadata||{}});
    return{modified:true,etag};
  }
  async delete(key){this.map.delete(key);}
}

const records = [];
let sequence = 0;
function response(ok, data, status = 200) {
  return { ok, status, async json() { return data; } };
}

global.fetch = async function(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 4)));
  if (method === 'GET') return response(true, { records: records.map(item => ({ ...item, fields: { ...item.fields } })) });
  if (method === 'POST') {
    const body = JSON.parse(options.body || '{}');
    const record = { id: `recTEST${String(++sequence).padStart(8, '0')}`, createdTime: new Date(Date.now() + sequence).toISOString(), fields: { ...(body.records?.[0]?.fields || {}) } };
    records.push(record);
    return response(true, { records: [record] });
  }
  if (method === 'PATCH') {
    const id = decodeURIComponent(String(url).split('/').pop());
    const body = JSON.parse(options.body || '{}');
    const record = records.find(item => item.id === id);
    if (!record) return response(false, { message: 'No encontrado' }, 404);
    Object.assign(record.fields, body.fields || {});
    return response(true, { ...record, fields: { ...record.fields } });
  }
  return response(false, { message: 'Método no soportado' }, 405);
};

process.env.AIRTABLE_API_TOKEN = 'test-token';
process.env.AIRTABLE_BASE_ID = 'appTEST';

const atomic = require(path.join(__dirname, '..', 'netlify', 'functions', '_idempotency_store'));
atomic.setStoreFactoryForTests(() => newStore);
const newStore = new MemoryStore();
const guard = require(path.join(__dirname, '..', 'netlify', 'functions', '_operation_guard'));

(async () => {
  const [a, b] = await Promise.all([
    guard.begin('PAYMENT_REPORT', 'recREPORT0000001'),
    guard.begin('PAYMENT_REPORT', 'recREPORT0000001')
  ]);
  assert.strictEqual([a, b].filter(item => item.ok).length, 1, 'Solo una operación concurrente debe ganar');
  assert.strictEqual([a, b].filter(item => !item.ok && item.reason === 'running').length, 1, 'La segunda operación debe quedar bloqueada');

  const winner = a.ok ? a : b;
  await guard.setState(winner.marker, 'PAYMENT_REPORT', 'recREPORT0000001', 'DONE', 'recPAYMENT000001');
  const repeated = await guard.begin('PAYMENT_REPORT', 'recREPORT0000001');
  assert.strictEqual(repeated.ok, false);
  assert.strictEqual(repeated.reason, 'done');
  assert.strictEqual(repeated.marker.resultId, 'recPAYMENT000001');
  atomic.setStoreFactoryForTests(null);

  console.log('STAGE1_SECURITY_TESTS_OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
