// netlify/functions/airtable.js
exports.handler = async function(event) {
    const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;
    const { path, httpMethod, body } = event;

    const airtablePath = path.replace('/.netlify/functions/airtable', '');
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}${airtablePath}`;

    try {
        const response = await fetch(url, {
            method: httpMethod,
            headers: {
                'Authorization': `Bearer ${AIRTABLE_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: httpMethod !== 'GET' ? body : undefined
        });
        const data = await response.json();
        if (!response.ok) {
            return { statusCode: response.status, body: JSON.stringify(data) };
        }
        return { statusCode: 200, body: JSON.stringify(data) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ message: 'Error en la función del servidor.' }) };
    }
};
