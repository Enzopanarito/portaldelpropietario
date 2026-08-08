'use strict';

// Tapón permanente: Netlify puede conservar una función de un despliegue
// anterior aunque el archivo desaparezca en un upload incremental.
exports.handler=async()=>({
 statusCode:404,
 headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
 body:JSON.stringify({message:'Not Found'})
});
