// netlify/functions/gemini.js
exports.handler = async function(event) {
    // 1. El camarero toma la llave secreta de Gemini de la caja fuerte de Netlify.
    const { GEMINI_API_KEY } = process.env;

    // 2. Revisa el pedido del cliente (el prompt que enviaste).
    const { prompt } = JSON.parse(event.body);

    if (!prompt) {
        return { statusCode: 400, body: JSON.stringify({ message: 'No se proporcionó un prompt.' }) };
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };

    // 3. Va a la "cocina" de Gemini con la llave y hace el pedido.
    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            return { statusCode: response.status, body: JSON.stringify(data) };
        }
        // 4. Regresa y le entrega la respuesta de la IA al cliente.
        return { statusCode: 200, body: JSON.stringify(data) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ message: 'Error en la función de Gemini.' }) };
    }
};
