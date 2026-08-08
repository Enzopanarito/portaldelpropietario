function nativeLambdaRequest(request,pathname){
  const source=new URL(request.url),target=new URL(pathname,source);
  target.search=source.search;
  return new Request(target,request);
}

// El comprobante se procesa en la función Lambda nativa. Ese salto interno
// conserva método, cabeceras y cuerpo, y permite que Netlify adjunte el
// contexto Blobs necesario para cifrar, reservar y verificar el archivo.
export default request=>fetch(nativeLambdaRequest(request,'/.netlify/functions/public-report-payment'));
export const config={path:'/api/vla/report-payment',method:'POST'};
export{nativeLambdaRequest};
