// netlify/functions/login.js

const { issueAdminToken } = require('./_auth');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }

  try {
    const { password } = JSON.parse(event.body || '{}');
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'La contraseña de administrador no está configurada en el servidor.' }) };
    }

    if (password === adminPassword) {
      const token = issueAdminToken();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ success: true, token, expiresInHours: 12 })
      };
    }

    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, message: 'Contraseña incorrecta.' }) };
  } catch (error) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Error en el servidor.' }) };
  }
};
