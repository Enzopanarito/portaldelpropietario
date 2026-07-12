const { requireAdminCurrent } = require('./_auth');

exports.handler = async (event) => {
  const auth = await requireAdminCurrent(event);
  if (!auth.ok) return auth.response;
  const token = process.env.AIRTABLE_API_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const url = `https://api.airtable.com/v0/meta/bases/${baseId}/tables`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ControlVersiones',
        fields: [
          { name: 'Key', type: 'singleLineText' },
          { name: 'Version', type: 'number', options: { precision: 0 } }
        ]
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return { statusCode: 200, body: JSON.stringify({ ok: true, table: data }) };
  } catch (err) {
    console.error('create-versioning error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
