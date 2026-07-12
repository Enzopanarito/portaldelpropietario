// Endpoint retirado: no era utilizado por el portal y exponía consumo de una clave privada.
'use strict';

exports.handler = async function() {
  return {
    statusCode: 410,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body: JSON.stringify({
      success: false,
      message: 'Esta función fue deshabilitada por seguridad.'
    })
  };
};
