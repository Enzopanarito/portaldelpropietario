// netlify/functions/login.js

exports.handler = async function(event) {
  // Solo permitir peticiones POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { password } = JSON.parse(event.body);
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return { statusCode: 500, body: JSON.stringify({ message: 'La contraseña de administrador no está configurada en el servidor.' }) };
    }

    if (password === adminPassword) {
      // La contraseña es correcta
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } else {
      // La contraseña es incorrecta
      return { statusCode: 401, body: JSON.stringify({ success: false, message: 'Contraseña incorrecta.' }) };
    }
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Error en el servidor.' }) };
  }
};