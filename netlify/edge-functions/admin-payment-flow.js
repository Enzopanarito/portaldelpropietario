const PAYMENT_FLOW = 'protected-v3';

const protectedHandleReport = "async function handleReport(e){const btn=e.target.closest('button');if(!btn||window.vlaReportBusy)return;const id=btn.dataset.id,r=reportes.find(x=>x.id===id);if(!r)return;const approve=btn.classList.contains('confirm-report'),reject=btn.classList.contains('reject-report');if(!approve&&!reject)return;if(reject&&!confirm('¿Rechazar este pago?'))return;const original=btn.textContent;try{window.vlaReportBusy=true;btn.disabled=true;btn.textContent=approve?'Confirmando...':'Rechazando...';const processed=await adminFetch('/.netlify/functions/process-payment-report',{method:'POST',body:JSON.stringify({reportId:id,decision:approve?'approve':'reject'})});toast(processed.message||(approve?'Pago confirmado, recibo procesado y acceso sincronizado.':'Pago rechazado y acceso sincronizado.'));await loadAll(true)}catch(err){toast(err.message,true)}finally{window.vlaReportBusy=false;btn.disabled=false;btn.textContent=original}}";

const handleReportPattern = /async function handleReport\(e\)\{[\s\S]*?\}\nfunction closeRows\(\)/;

export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const matched = handleReportPattern.test(html);
  if (matched) {
    html = html.replace(handleReportPattern, protectedHandleReport + '\nfunction closeRows()');
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-vla-admin-payment-flow', matched ? PAYMENT_FLOW : 'pattern-missing');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};
