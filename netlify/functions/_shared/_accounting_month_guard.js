'use strict';

function clean(value){return String(value||'').trim()}
function previousMonth(month){
 const match=/^(\d{4})-(\d{2})$/.exec(clean(month));
 if(!match)return'';
 const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-2,1));
 return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function closePrefix(month){return`MONTHLY_CLOSE|${month}|`}
function markerStatus(record,month){
 const key=clean(record?.fields?.Key),prefix=closePrefix(month);
 if(!key.startsWith(prefix))return'';
 const rest=key.slice(prefix.length),separator=rest.indexOf('|');
 return separator<0?'':rest.slice(0,separator);
}
function closeStatus(records,month){
 const statuses=(records||[]).map(record=>markerStatus(record,month)).filter(Boolean);
 if(statuses.includes('DONE'))return'DONE';
 if(statuses.includes('ERROR_PARTIAL'))return'ERROR_PARTIAL';
 if(statuses.includes('LOCKED'))return'LOCKED';
 if(statuses.includes('ERROR_SAFE'))return'ERROR_SAFE';
 if(statuses.includes('ABORTED'))return'ABORTED';
 return'MISSING';
}
function resolveAccountingTransition(calendarMonth,closeRecords=[]){
 const priorMonth=previousMonth(calendarMonth),priorCloseStatus=closeStatus(closeRecords,priorMonth);
 const pending=priorCloseStatus!=='DONE';
 return{
  pending,
  calendarMonth,
  accountingMonth:pending?priorMonth:calendarMonth,
  previousMonth:priorMonth,
  previousCloseStatus:priorCloseStatus,
  mode:pending?'PREVIOUS_MONTH_FAIL_CLOSED':'CURRENT_MONTH'
 };
}
function closeMarkerQuery(month){
 const prefix=closePrefix(month),formula=encodeURIComponent(`LEFT({Key}, ${prefix.length})='${prefix}'`);
 return`?filterByFormula=${formula}&fields%5B%5D=${encodeURIComponent('Key')}`;
}

module.exports={previousMonth,closePrefix,markerStatus,closeStatus,resolveAccountingTransition,closeMarkerQuery};
