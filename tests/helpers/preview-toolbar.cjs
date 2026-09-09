'use strict';

// Solo elimina la herramienta de colaboración del proveedor en el navegador
// de pruebas de Deploy Preview. No toca UI de VLA ni respuestas de sus APIs.
async function suppressPreviewToolbar(page, target) {
  if (!/^https:\/\/deploy-preview-\d+--villalosapamates\.netlify\.app\/?$/.test(target)) return;
  await page.addInitScript(() => {
    const remove = () => document.querySelectorAll('[data-netlify-deploy-id],iframe[title="Netlify Drawer"]').forEach(node => node.remove());
    new MutationObserver(remove).observe(document, { childList: true, subtree: true });
    remove();
  });
}
module.exports = { suppressPreviewToolbar };
