export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;

  let html = await response.text();
  const link = "<a href='/whatsapp.html' target='_self' class='bg-green-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📲 WhatsApp</a>";

  if (!html.includes("/whatsapp.html")) {
    const auditSingle = "<a href='/auditoria.html' target='_blank' class='bg-indigo-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📚 Auditoría</a>";
    const auditDouble = '<a href="/auditoria.html" target="_blank" class="bg-indigo-600 text-white px-4 py-2 rounded-full shadow font-semibold">📚 Auditoría</a>';
    const backupButton = "<button id='backup-btn' class='bg-slate-900 text-white px-4 py-2 rounded-full shadow font-semibold'>💾 Respaldo</button>";
    if (html.includes(auditSingle)) html = html.replace(auditSingle, link + auditSingle);
    else if (html.includes(auditDouble)) html = html.replace(auditDouble, link + auditDouble);
    else if (html.includes(backupButton)) html = html.replace(backupButton, link + backupButton);
    else html = html.replace('</nav>', link + '</nav>');
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('cache-control', 'no-store, no-cache, must-revalidate');
  headers.set('content-type', 'text/html; charset=utf-8');

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};
