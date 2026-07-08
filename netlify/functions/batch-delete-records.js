// netlify/functions/batch-delete-records.js
// Elimina varios registros de Airtable en lotes de 10.
// Uso principal: borrar múltiples gastos del mes con una sola acción desde el admin.

const ALLOWED_TABLES = new Set(['Gastos del Mes']);
const MAX_RECORDS_PER_REQUEST = 100;
const AIRTABLE_DELETE_BATCH_SIZE = 10;

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

exports.handler = async function(event) {
  const { AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID } = process.env;

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ message: 'Method Not Allowed' }) };
  }

  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ message: 'Airtable no está configurado.' }) };
  }

  try {
    const { tableName, recordIds } = JSON.parse(event.body || '{}');

    if (!ALLOWED_TABLES.has(tableName)) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Tabla no permitida para eliminación en lote.' }) };
    }

    if (!Array.isArray(recordIds) || recordIds.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ message: 'Debe enviar al menos un registro para eliminar.' }) };
    }

    if (recordIds.length > MAX_RECORDS_PER_REQUEST) {
      return { statusCode: 400, body: JSON.stringify({ message: `Máximo ${MAX_RECORDS_PER_REQUEST} registros por operación.` }) };
    }

    const cleanIds = [...new Set(recordIds.map(id => String(id || '').trim()).filter(Boolean))];
    const deleted = [];

    for (const batch of chunk(cleanIds, AIRTABLE_DELETE_BATCH_SIZE)) {
      const params = new URLSearchParams();
      batch.forEach(id => params.append('records[]', id));

      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}?${params.toString()}`;
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${AIRTABLE_API_TOKEN}` }
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error eliminando registros en Airtable.');
      }

      deleted.push(...(data.records || []));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ success: true, deletedCount: deleted.length, deleted })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error eliminando registros.', detail: error.message })
    };
  }
};
