// Ruta: netlify/functions/gemini.js (CON CÓDIGO DE DEPURACIÓN)

exports.handler = async (event) => {
  // --- INICIO DE DEPURACIÓN ---
  // Esta línea nos mostrará en los logs si la variable existe o no.
  console.log('Iniciando función gemini...');
  console.log('Valor de GEMINI_API_KEY:', process.env.GEMINI_API_KEY);
  // --- FIN DE DEPURACIÓN ---

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    // Si la variable no existe, devolvemos un error claro.
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'La variable de entorno GEMINI_API_KEY no se encontró en la configuración de Netlify.' }),
    };
  }

  let prompt;
  try {
    const body = JSON.parse(event.body);
    prompt = body.prompt;
    if (!prompt) throw new Error('El campo "prompt" es requerido.');
  } catch (error) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Cuerpo de la solicitud inválido o falta el "prompt".' }),
    };
  }
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;

  try {
    const geminiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    const data = await geminiResponse.json();

    return {
      statusCode: geminiResponse.status,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al contactar la API de Gemini.' }),
    };
  }
};
