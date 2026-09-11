'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');

function edge(name) {
  const context = { module: { exports: {} }, Response, Headers };
  vm.runInNewContext(fs.readFileSync(`netlify/edge-functions/${name}.js`, 'utf8').replace('export default', 'module.exports ='), context);
  return context.module.exports;
}

(async () => {
  const names = [...fs.readFileSync('netlify.toml', 'utf8').matchAll(/\[\[edge_functions\]\]\s*function = "([^"]+)"\s*path = "\/admin\*"/g)].map(x => x[1]);
  const run = i => i === names.length ? new Response(fs.readFileSync('admin.html', 'utf8'), { headers: { 'content-type': 'text/html' } }) : edge(names[i])(new Request('https://vla.test/admin.html'), { next: () => run(i + 1) });
  const html = await (await run(0)).text();
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).find(x => x.includes("const endpoint='/api/vla/communications'"));
  const panel = html.slice(html.indexOf('<div id="vla-communications"'), html.indexOf('</section>', html.indexOf('<div id="vla-communications"')));
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
      await page.goto('https://vla.test/admin.html');
      await page.setContent(`<style>.hidden,.section:not(.active){display:none}.whitespace-pre-wrap{white-space:pre-wrap}textarea{max-width:100%}</style><div id="app" class="hidden"><button data-target="communications">Comunicaciones</button><section id="communications" class="section">${panel}</section></div>`);
      await page.evaluate(() => {
        window.calls = [];
        window.toast = () => {};
        window.confirm = () => false;
        window.adminFetch = async (url, options) => {
          const body = JSON.parse(options?.body || '{}');
          window.calls.push({ url, body });
          if (url.includes('action=catalog')) return { owners: [{ id: 'recABCDEFGHIJKLMN', house: 1, name: 'Propietario de prueba', emailConfigured: true }], expenses: [], notice: null, recent: [] };
          if (body.action === 'improve') return { subject: 'Compra de gasoil', body: 'Informamos a {{nombre}} de la casa {{casa}} sobre la compra.' };
          if (body.action === 'create-job') return { job: { jobId: 'COM-20260909-ABCDEF123456' }, dispatchPath: '/api/vla/communications-dispatch' };
          if (body.action === 'publish-notice') return { notice: { title: 'Información', body: 'Aviso de prueba', level: 'info', expiresAt: new Date(Date.now() + 86400000).toISOString() } };
          return {};
        };
      });
      await page.addScriptTag({ content: script });
      assert.equal(await page.evaluate(() => calls.length), 0, 'No debe llamar APIs antes del login');
      await page.evaluate(() => {
        sessionStorage.setItem('vla-admin-token', 'fixture-not-a-real-token');
        sessionStorage.setItem('vla-admin-auth', 'true');
        document.getElementById('app').classList.remove('hidden');
      });
      assert.equal(await page.evaluate(() => calls.length), 0, 'No debe cargar comunicaciones al entrar al administrador');
      await page.click('[data-target="communications"]');
      await page.locator('.com-owner').waitFor();
      assert.ok(await page.locator('#com-body').isVisible());
      assert.ok(await page.locator('#notice-body').isVisible());
      await page.fill('#com-subject', 'Compra');
      await page.fill('#com-body', 'Se compró gasoil.');
      await page.click('#com-improve');
      await page.waitForFunction(() => document.getElementById('com-subject').value === 'Compra de gasoil');
      await page.click('#com-preview');
      const preview = await page.locator('#com-preview-box').textContent();
      assert.ok(preview.includes('\n\nEstimado(a)'));
      assert.ok(preview.includes('Informamos a Propietario de prueba de la casa 1'));
      await page.click('#com-send');
      assert.equal(await page.evaluate(() => calls.filter(x => x.body.action === 'create-job').length), 0);
      await page.evaluate(() => { window.confirm = () => true; });
      await page.click('#com-send');
      await page.waitForFunction(() => calls.some(x => x.url.includes('communications-dispatch-background')));
      assert.equal(await page.evaluate(() => calls.filter(x => x.body.action === 'create-job').length), 1);
      await page.fill('#notice-title', 'Información');
      await page.fill('#notice-body', 'Aviso de prueba');
      await page.click('#notice-publish');
      await page.waitForFunction(() => calls.some(x => x.body.confirm === 'PUBLICAR'));
      assert.deepEqual(errors, []);
      console.log(`COMUNICACIONES_BROWSER_OK width=${width}: cuadros, IA simulada, personalización, confirmación y publicación simulada`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
