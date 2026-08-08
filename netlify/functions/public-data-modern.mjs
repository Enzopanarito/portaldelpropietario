function nativeLambdaRequest(request,pathname){
  const source=new URL(request.url),target=new URL(pathname,source);
  target.search=source.search;
  return new Request(target,request);
}

// Esta ruta pública conserva la URL estable, pero delega en la función Lambda
// nativa para que Netlify entregue `event.blobs` sin que aws-lambda-compat lo
// descarte al sintetizar el evento.
export default request=>fetch(nativeLambdaRequest(request,'/.netlify/functions/public-data-v3'));
export const config={path:'/api/vla/public-data',method:'GET'};
export{nativeLambdaRequest};
