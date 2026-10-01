'use strict';

function previousMonth(month){
  const match=/^(\d{4})-(\d{2})$/.exec(String(month||''));
  if(!match)return'';
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-2,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}

function caracasMonth(now=new Date()){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/Caracas',year:'numeric',month:'2-digit'
  }).formatToParts(now).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}`;
}

function closeState(records,month){
  const prefix=`MONTHLY_CLOSE|${month}|`;
  const states=(records||[]).map(record=>{
    const key=String(record?.fields?.Key||'');
    if(!key.startsWith(prefix))return'';
    return key.slice(prefix.length).split('|')[0]||'';
  }).filter(Boolean);
  if(states.includes('DONE'))return'DONE';
  if(states.includes('LOCKED'))return'LOCKED';
  return states[0]||'MISSING';
}

function shouldQueue(records,month){
  const state=closeState(records,month);
  return{queue:state!=='DONE'&&state!=='LOCKED',state};
}

module.exports={previousMonth,caracasMonth,closeState,shouldQueue};
