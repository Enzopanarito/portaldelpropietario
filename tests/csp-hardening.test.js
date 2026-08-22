'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const netlify=fs.readFileSync(path.join(root,'netlify.toml'),'utf8');

function topLevelHtml(){
  return fs.readdirSync(root)
    .filter(name=>name.endsWith('.html'))
    .map(name=>({name,text:fs.readFileSync(path.join(root,name),'utf8')}));
}

test('CSP bloquea handlers inline y contenido en frames',()=>{
  assert.match(netlify,/script-src-attr 'none'/);
  assert.match(netlify,/frame-src 'none'/);
  assert.match(netlify,/object-src 'none'/);
  assert.match(netlify,/base-uri 'self'/);
  assert.match(netlify,/form-action 'self'/);
});

test('HTML canónico no depende de atributos JavaScript inline',()=>{
  const dangerous=/\s(onclick|ondblclick|onerror|onload|onsubmit|onchange|oninput|onmouseover|onfocus)\s*=/i;
  for(const file of topLevelHtml()) assert.doesNotMatch(file.text,dangerous,`${file.name} contiene un event handler inline incompatible con CSP`);
});

test('CSP mantiene explícitamente la transición pendiente de bloques inline',()=>{
  // Este test documenta el estado intermedio: cerramos atributos inline ahora,
  // pero no declaramos falsamente resuelta la migración completa de scripts.
  assert.match(netlify,/script-src 'self' 'unsafe-inline'/);
});
