export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  const url = new URL(request.url);
  const p = url.pathname.toLowerCase();
  const isOwnerPortal = p === '/' || p === '/index.html' || p === '';
  if (!isOwnerPortal) return response;

  let html = await response.text();
  if (html.includes('vla-digital-signature-footer')) return new Response(html, response);

  const signature = `
<style id="vla-digital-signature-footer-style">
  .vla-digital-signature-footer{
    max-width:1500px;
    margin:0 auto;
    padding:18px 18px 108px;
    text-align:center;
    color:#64748b;
    font-size:12px;
    letter-spacing:.02em;
  }
  .vla-digital-signature-footer .vla-signature-card{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    gap:10px;
    padding:12px 18px;
    border:1px solid rgba(15,23,42,.08);
    border-radius:999px;
    background:rgba(255,255,255,.76);
    box-shadow:0 12px 32px rgba(15,23,42,.06);
    backdrop-filter:blur(14px);
  }
  .vla-digital-signature-footer .vla-signature-mark{
    width:7px;
    height:7px;
    border-radius:999px;
    background:linear-gradient(135deg,#0b7a34,#073b55);
    box-shadow:0 0 0 4px rgba(11,122,52,.10);
  }
  .vla-digital-signature-footer strong{
    color:#0f172a;
    font-weight:900;
  }
  .vla-digital-signature-footer .vla-signature-seal{
    color:#0b7a34;
    font-weight:900;
    text-transform:uppercase;
    letter-spacing:.08em;
    font-size:10px;
  }
  html.dark .vla-digital-signature-footer{color:#cbd5e1;}
  html.dark .vla-digital-signature-footer .vla-signature-card{
    background:rgba(15,23,42,.80);
    border-color:#334155;
    box-shadow:0 12px 32px rgba(0,0,0,.28);
  }
  html.dark .vla-digital-signature-footer strong{color:#f8fafc;}
  html.dark .vla-digital-signature-footer .vla-signature-seal{color:#86efac;}
</style>
<footer id="vla-digital-signature-footer" class="vla-digital-signature-footer" aria-label="Firma digital del sistema">
  <div class="vla-signature-card">
    <span class="vla-signature-mark" aria-hidden="true"></span>
    <span>Sistema generado por <strong>Enzo Panarito</strong> para <strong>Villa Los Apamates</strong> · 2025</span>
    <span class="vla-signature-seal">Digital System</span>
  </div>
</footer>
<script id="vla-payment-report-submit-guard">
(function(){
  function normalizeReference(value){
    return String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').trim().replace(/\\s+/g,' ').toLowerCase();
  }
  function fingerprint(ownerId,mode,amount,reference){
    return ['vla-report',ownerId,mode,Number(amount||0).toFixed(2),normalizeReference(reference)].join('|');
  }
  function install(){
    var form=document.getElementById('reportForm');
    var button=document.getElementById('submitReport');
    if(!form||!button||form.dataset.vlaGuardInstalled==='1')return;
    form.dataset.vlaGuardInstalled='1';
    form.onsubmit=async function(event){
      event.preventDefault();
      if(window.vlaReportBusy)return;
      var mode=document.getElementById('payMode').value;
      var amount=Number(document.getElementById('payAmount').value);
      var reference=document.getElementById('payRef').value.trim();
      try{
        if(!mode)throw new Error('Seleccione la forma de pago.');
        if(!(amount>0)||!reference)throw new Error('Complete monto y referencia.');
        if(typeof currentOwner==='undefined'||!currentOwner||!currentOwner.id)throw new Error('Seleccione nuevamente su casa.');
        var key=fingerprint(currentOwner.id,mode,amount,reference);
        var last=Number(localStorage.getItem(key)||0);
        if(last&&Date.now()-last<300000){
          throw new Error('Este pago ya fue reportado recientemente. La administración se encuentra verificándolo. Espere al menos 5 minutos antes de intentar nuevamente.');
        }
        window.vlaReportBusy=true;
        button.disabled=true;
        button.textContent='Enviando reporte...';
        var response=await fetch('/.netlify/functions/public-report-payment',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ownerId:currentOwner.id,mode:mode,amount:amount,reference:reference,rate:rate(),date:caracasDate()})
        });
        var data=await response.json().catch(function(){return{}});
        if(!response.ok)throw new Error(data.detail||data.message||'Error reportando pago.');
        localStorage.setItem(key,String(Date.now()));
        hideModal();
        toast(data.message||'Pago reportado correctamente. La administración verificará la información en un plazo no mayor de 72 horas.',false);
      }catch(error){
        toast(error.message||'Error reportando pago.',true);
      }finally{
        window.vlaReportBusy=false;
        button.disabled=false;
        button.textContent='Enviar Reporte';
      }
    };
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
</script>`;

  if (html.includes('</body>')) html = html.replace('</body>', signature + '</body>');
  else html += signature;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(html, { status: response.status, statusText: response.statusText, headers });
};