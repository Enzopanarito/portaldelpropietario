export default async (request,context)=>{
  const response=await context.next();
  const type=response.headers.get('content-type')||'';
  if(!type.toLowerCase().includes('text/html'))return response;
  const html=await response.text();
  const headers=new Headers(response.headers);
  headers.delete('content-length');headers.delete('content-encoding');
  headers.set('cache-control','no-store, no-cache, must-revalidate');
  headers.set('content-type','text/html; charset=utf-8');
  headers.set('x-vla-admin-source','native-protected-ui');
  return new Response(html,{status:response.status,statusText:response.statusText,headers});
};
