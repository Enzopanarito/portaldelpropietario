'use strict';

const { requireAdminCurrent } = require('./_auth');

const TABLE = 'ControlVersiones';
const PREFIX = 'BCV_LAST_GOOD|';

function endpoint(query='') { return `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE)}${query}`; }
async function request(query='', options={}) {
  const response = await fetch(endpoint(query), { ...options, headers:{ Authorization:`Bearer ${process.env.AIRTABLE_API_TOKEN}`, 'Content-Type':'application/json', ...(options.headers||{}) } });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `Airtable ${response.status}`);
  return data;
}
function decode(record) {
  try {
    const key = String(record?.fields?.Key || '');
    if (!key.startsWith(PREFIX)) return null;
    return JSON.parse(Buffer.from(key.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch (_) { return null; }
}
exports.handler = async function(event) {
  const auth = await requireAdminCurrent(event); if (!auth.ok) return auth.response;
  if (event.httpMethod !== 'POST') return { statusCode:405, body:JSON.stringify({message:'Method Not Allowed'}) };
  try {
    if (!process.env.AIRTABLE_API_TOKEN || !process.env.AIRTABLE_BASE_ID) throw new Error('Airtable no configurado.');
    const body = JSON.parse(event.body || '{}');
    if (body.action !== 'prune') return { statusCode:400, body:JSON.stringify({message:'Acción inválida.'}) };
    let records=[], offset=null;
    do {
      const params=new URLSearchParams({pageSize:'100',filterByFormula:`LEFT({Key}, ${PREFIX.length})='${PREFIX}'`});
      if(offset)params.set('offset',offset);
      const data=await request(`?${params.toString()}`);records.push(...(data.records||[]));offset=data.offset||null;
    } while(offset);
    const valid=records.map(record=>({record,payload:decode(record)})).filter(item=>item.payload?.rate).sort((a,b)=>String(b.record.createdTime||'').localeCompare(String(a.record.createdTime||'')));
    const keep=valid[0]?.record?.id || null;
    const remove=records.filter(record=>record.id!==keep);
    for(let i=0;i<remove.length;i+=10){const params=new URLSearchParams();remove.slice(i,i+10).forEach(record=>params.append('records[]',record.id));await request(`?${params.toString()}`,{method:'DELETE'});}
    return { statusCode:200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body:JSON.stringify({success:true,kept:keep,deleted:remove.length,totalBefore:records.length}) };
  } catch(error) { return { statusCode:500, headers:{'Content-Type':'application/json'}, body:JSON.stringify({success:false,message:error.message}) }; }
};
