export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;
  let html = await response.text();
  const path = new URL(request.url).pathname.toLowerCase();
  const isAdmin = path.includes('admin');

  if (isAdmin) {
    const adminCalc = "function calc(o){const debtUsd=money(Number(o['Saldo USD Actual']!==undefined?o['Saldo USD Actual']:o['Deuda Anterior USD']||0)),debtBs=money(Number(o['Saldo Bs Ref Actual']!==undefined?o['Saldo Bs Ref Actual']:o['Deuda Anterior Bs Ref']||0)),total=money(Number(o['Saldo Total Actual']!==undefined?o['Saldo Total Actual']:o['Deuda Restante']||0)),legacy=money(Number(o['Deuda Restante Airtable']!==undefined?o['Deuda Restante Airtable']:o['Deuda Restante']||0)),expired=money(Number(o['Deuda Vencida Total']||0)),currentMonth=money(Number(o['Mes Corriente Total']!==undefined?o['Mes Corriente Total']:Math.max(0,total)-expired)),recargo=money(Number(o['Recargo Aplicado']||0));return{debtUsd,debtBs,total,rawTotal:total,legacy,diff:0,bsDue:money(Math.max(0,debtBs)*rate()),expired,currentMonth,recargo}}";
    html = html.replace(/function calc\(o\)\{[\s\S]*?\}function saldoFavorText/, adminCalc + 'function saldoFavorText');
  } else if (path === '/' || path === '/index.html' || path === '') {
    const ownerCalc = "function calc(o){let usdBal=Number(o['Deuda Anterior USD']||0),bsBal=Number(o['Deuda Anterior Bs Ref']||0);const split=Math.abs(usdBal)>0.001||Math.abs(bsBal)>0.001;if(!split)bsBal+=Number(o['Deuda Anterior']||0);const linesUsd=[],linesBs=[];if(Math.abs(usdBal)>0.01)linesUsd.push({concept:'Deuda anterior pagadera en dólares',totalAmount:usdBal,amount:usdBal});if(Math.abs(bsBal)>0.01)linesBs.push({concept:'Deuda anterior pagadera en bolívares',totalAmount:bsBal,amount:bsBal});all.gastos.forEach(g=>{const share=ownerShare(g,o);if(share<=0)return;const f=g.fields||{},line={concept:f.Concepto||'Gasto',totalAmount:Number(f.Monto||share),amount:share,type:f['Tipo de Gasto']||''};if((f['Forma de Pago']||'Bs BCV')==='USD')linesUsd.push(line);else linesBs.push(line)});const recargo=money(Number(o['Recargo Aplicado']||0));if(recargo>0.01)linesBs.push({concept:'Recargo 10% por no aprovechar pronto pago',totalAmount:recargo,amount:recargo,type:'Recargo'});const active=all.pagos.filter(p=>((p.fields||{})['Propietario que Paga']||[]).includes(o.id)&&((p.fields||{})['[x] Aplicado al Cierre']!==true));let paidUsd=0,paidBs=0;active.forEach(p=>{if(((p.fields||{})['Forma de Pago']||'Bs BCV')==='USD')paidUsd+=payUsd(p);else paidBs+=payUsd(p)});const debtUsd=money(Number(o['Saldo USD Actual']!==undefined?o['Saldo USD Actual']:0)),debtBs=money(Number(o['Saldo Bs Ref Actual']!==undefined?o['Saldo Bs Ref Actual']:0)),total=money(Number(o['Saldo Total Actual']!==undefined?o['Saldo Total Actual']:o['Deuda Restante']||0)),saldoFavor=total<-.01?Math.abs(total):0,bsDue=money(Math.max(0,debtBs)*rate()),expired=money(Number(o['Deuda Vencida Total']||0)),currentMonth=money(Number(o['Mes Corriente Total']!==undefined?o['Mes Corriente Total']:Math.max(0,total)-expired));return{linesUsd,linesBs,paidUsd:money(paidUsd),paidBs:money(paidBs),debtUsd,debtBs,total,saldoFavor,bsDue,active,expired,currentMonth,recargo}}";
    html = html.replace(/function calc\(o\)\{[\s\S]*?\}function portonStatus/, ownerCalc + 'function portonStatus');
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-balance-engine', 'v4');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};
