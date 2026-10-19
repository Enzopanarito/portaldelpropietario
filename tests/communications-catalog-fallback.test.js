'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadCatalog, publicCatalog } = require('../netlify/functions/_shared/_communications_catalog');
const { currentMonthCaracas } = require('../netlify/functions/_shared/_expense_lifecycle');

const owners = Array.from({ length: 15 }, (_, index) => ({
  id: `rec${String(index + 1).padStart(14, '0')}`,
  fields: { Casa: index + 1, Propietario: `Propietario de prueba ${index + 1}`, Email: `casa${index + 1}@example.invalid`, Alicuota: 1 / 15 }
}));
async function withAirtableMock(expenseMode, run) {
  const oldFetch = global.fetch, token = process.env.AIRTABLE_API_TOKEN, base = process.env.AIRTABLE_BASE_ID;
  const queries = [];
  process.env.AIRTABLE_API_TOKEN = 'test-only';
  process.env.AIRTABLE_BASE_ID = 'appTEST0000000000';
  global.fetch = async (url) => {
    const parsed = new URL(url);
    const table = decodeURIComponent(parsed.pathname.split('/').at(-1));
    queries.push({ table, fields: parsed.searchParams.getAll('fields[]') });
    if (table === 'Propietarios') return new Response(JSON.stringify({ records: owners }), { status: 200 });
    if (table !== 'Gastos del Mes') return new Response('{}', { status: 404 });
    if (expenseMode === 'fail') return new Response(JSON.stringify({error:{message:'Expense endpoint failed'}}), {status: 422});
    return new Response(JSON.stringify({records:[{
      id:'recEXAMPLEEXPENSE',fields:{Concepto:'Prueba',Monto:5,Propietarios:[owners[0].id], 'Mes de Aplicación':currentMonthCaracas(),'Estado del Gasto':'Activo'}
    }]}), {status:200});
  };
  try { await run(queries); } finally {
    global.fetch = oldFetch;
    if (token === undefined) delete process.env.AIRTABLE_API_TOKEN; else process.env.AIRTABLE_API_TOKEN = token;
    if (base === undefined) delete process.env.AIRTABLE_BASE_ID; else process.env.AIRTABLE_BASE_ID = base;
  }
}
test('catalogo: quince propietarios y campos reales de Airtable', async () => {
  await withAirtableMock('ok', async queries => {
    const catalog = await loadCatalog();
    assert.equal(catalog.owners.length, 15);
    assert.equal(publicCatalog(catalog).owners.length, 15);
    assert.equal(catalog.expenses.length, 1);
    assert.equal(catalog.expenseWarning, null);
    const fields = queries.find(q => q.table === 'Gastos del Mes').fields;
    assert.ok(fields.includes('Mes de Aplicación'));
    assert.ok(fields.includes('Estado del Gasto'));
    assert.ok(!fields.includes('Mes Contable'));
    assert.ok(!fields.includes('Estado Registro'));
  });
});
test('un error opcional de gastos no bloquea destinatarios, pero bloquea gastos vinculados', async () => {
  await withAirtableMock('fail', async () => {
    const catalog = await loadCatalog();
    assert.equal(catalog.owners.length, 15);
    assert.equal(catalog.expenses.length, 0);
    assert.match(publicCatalog(catalog).expenseWarning, /sin gasto vinculado/);
    await assert.rejects(loadCatalog({ requireExpenses: true }), /Expense endpoint failed/);
  });
});
test('sin destinatarios el boton muestra un error y no envia silenciosamente', () => {
  const ui = fs.readFileSync('netlify/edge-functions/admin-communications.js', 'utf8');
  assert.match(ui, /if\(!catalog\)return toast\('No se han cargado los destinatarios/);
  assert.match(ui, /if\(!ownerIds\.length\)return toast\('Seleccione al menos una casa/);
  assert.match(ui, /Complete asunto e información antes de enviar/);
  assert.match(ui, /confirm\('Se enviará este comunicado/);
});
