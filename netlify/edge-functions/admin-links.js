export default async (request, context) => {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let html = await response.text();
  const link = "<a href='/whatsapp.html' class='bg-green-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📲 WhatsApp</a>";
  const marker = "<a href='/auditoria.html' target='_blank' class='bg-indigo-600 text-white px-4 py-2 rounded-full shadow font-semibold'>📚 Auditoría</a>";
  if (!html.includes("href='/whatsapp.html'") && html.includes(marker)) {
    html = html.replace(marker, link + marker);
  }
  return new Response(html, response);
};
