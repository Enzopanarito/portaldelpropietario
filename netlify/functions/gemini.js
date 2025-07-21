// Ruta del archivo: netlify/functions/gemini.js

exports.handler = async (event) => {
  // 1. Extrae el "prompt" que envió tu portal desde el cuerpo de la solicitud
  let prompt;
  try {
    const body = JSON.parse(event.body);
    prompt = body.prompt;
    if (!prompt) {
      throw new Error('El campo "prompt" es requerido.');
    }
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Cuerpo de la solicitud inválido o falta el "prompt".' }),
    };
  }

  // 2. Llama a la API de Gemini de forma segura usando la variable de entorno
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'La variable GEMINI_API_KEY no está configurada en Netlify.' }),
    };
  }

  try {
    const geminiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
      }),
    });

    // Si Gemini devuelve un error, pásalo al frontend para más detalles
    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.json();
      return {
        statusCode: geminiResponse.status,
        body: JSON.stringify(errorData),
      };
    }

    const data = await geminiResponse.json();

    // 3. Devuelve la respuesta exitosa de Gemini a tu portal
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data), // Tu frontend espera la respuesta completa de Gemini
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al contactar la API de Gemini.' }),
    };
  }
};
