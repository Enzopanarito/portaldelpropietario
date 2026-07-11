const RELEASE = '2026-07-11-v6';

const ownerOverride = `<script id="vla-balance-contract-${RELEASE}">
(function(){
  if(window.__VLA_BALANCE_CONTRACT=== '${RELEASE}')return;
  window.__VLA_BALANCE_CONTRACT='${RELEASE}';
  var previous=window.calc;
  window.calc=function(o){
    if(!o||o['Saldo Oficial Activo']!==true){
      return typeof previous==='function'?previous(o):{linesUsd:[],linesBs:[],paidUsd:0,paidBs:0,debtUsd:0,debtBs:0,total:0,saldoFavor:0,bsDue:0,active:[],expired:0,currentMonth:0,recargo:0};
    }
    var m=typeof window.money==='function'?window.money:function(n){return Math.round(Number(n||0)*100)/100};
    var r=typeof window.rate==='function'?Number(window.rate()||0):0;
    var debtUsd=m(o['Saldo USD Actual']);
    var debtBs=m(o['Saldo Bs Ref Actual']);
    var total=m(o['Saldo Total Actual']);
    var recargo=m(o['Recargo Aplicado']);
    var expired=m(o['Deuda Vencida Total']);
    var currentMonth=m(o['Mes Corriente Total']);
    var baseBs=m(debtBs-recargo);
    var linesUsd=[];
    var linesBs=[];
    if(Math.abs(debtUsd)>0.01)linesUsd.push({concept:'Saldo corriente oficial en dólares',totalAmount:debtUsd,amount:debtUsd,type:'Saldo oficial'});
    if(Math.abs(baseBs)>0.01)linesBs.push({concept:'Saldo corriente oficial en bolívares',totalAmount:baseBs,amount:baseBs,type:'Saldo oficial'});
    if(recargo>0.01)linesBs.push({concept:'Recargo 10% por pérdida del pronto pago',totalAmount:recargo,amount:recargo,type:'Recargo'});
    return {linesUsd:linesUsd,linesBs:linesBs,paidUsd:0,paidBs:0,debtUsd:debtUsd,debtBs:debtBs,total:total,saldoFavor:total<-.01?Math.abs(total):0,bsDue:m(Math.max(0,debtBs)*r),active:[],expired:expired,currentMonth:currentMonth,recargo:recargo};
  };
})();
</script>`;

const adminOverride = `<script id="vla-admin-balance-contract-${RELEASE}">
(function(){
  if(window.__VLA_ADMIN_BALANCE_CONTRACT=== '${RELEASE}')return;
  window.__VLA_ADMIN_BALANCE_CONTRACT='${RELEASE}';
  var previous=window.calc;
  window.calc=function(o){
    if(!o||o['Saldo Oficial Activo']!==true)return typeof previous==='function'?previous(o):{debtUsd:0,debtBs:0,total:0,rawTotal:0,legacy:0,diff:0,bsDue:0,expired:0,currentMonth:0,recargo:0};
    var m=typeof window.money==='function'?window.money:function(n){return Math.round(Number(n||0)*100)/100};
    var r=typeof window.rate==='function'?Number(window.rate()||0):0;
    var debtUsd=m(o['Saldo USD Actual']);
    var debtBs=m(o['Saldo Bs Ref Actual']);
    var total=m(o['Saldo Total Actual']);
    var legacy=m(o['Deuda Restante Airtable']!==undefined?o['Deuda Restante Airtable']:total);
    var expired=m(o['Deuda Vencida Total']);
    var currentMonth=m(o['Mes Corriente Total']);
    var recargo=m(o['Recargo Aplicado']);
    return {debtUsd:debtUsd,debtBs:debtBs,total:total,rawTotal:total,legacy:legacy,diff:0,bsDue:m(Math.max(0,debtBs)*r),expired:expired,currentMonth:currentMonth,recargo:recargo};
  };
})();
</script>`;

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  const path = new URL(request.url).pathname.toLowerCase();
  const isAdmin = path.includes('admin');
  const isOwner = path === '/' || path === '/index.html' || path === '';
  let html = await response.text();

  const injection = isAdmin ? adminOverride : (isOwner ? ownerOverride : '');
  if (injection && !html.includes(`balance-contract-${RELEASE}`)) {
    html = html.includes('</body>') ? html.replace('</body>', injection + '</body>') : html + injection;
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-balance-engine', 'v6');
  headers.set('x-vla-balance-contract', RELEASE);
  headers.set('x-vla-balance-source', 'canonical-july-2026');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
