'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');

const build=fs.readFileSync('scripts/build-production.js','utf8');
const generator=fs.readFileSync('scripts/generate-social-card.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const social=fs.readFileSync('assets/vla-social-card.svg','utf8');
const icon=fs.readFileSync('assets/vla-icon.svg','utf8');

test('Open Graph y Twitter se materializan estáticamente en el build público',()=>{
  for(const needle of [
    'property="og:title"','property="og:description"','property="og:image"',
    'property="og:url"','property="og:type"','name="twitter:card"',
    'name="twitter:title"','name="twitter:description"','name="twitter:image"'
  ])assert.ok(build.includes(needle),`Falta ${needle}`);
  assert.match(build,/https:\/\/villalosapamates\.netlify\.app\/assets\/vla-social-card\.png/);
  assert.match(build,/og:image:width" content="1200"/);
  assert.match(build,/og:image:height" content="630"/);
});

test('la tarjeta social se genera como PNG 1200x630 y no depende de una Function',()=>{
  assert.match(social,/width="1200" height="630"/);
  assert.match(generator,/resize\(1200,630/);
  assert.match(generator,/vla-social-card\.png/);
  assert.doesNotMatch(build,/og:image" content="[^"]*\.netlify\/functions/i);
});

test('favicon y apple-touch-icon tienen assets PNG estáticos',()=>{
  assert.match(icon,/width="512" height="512"/);
  assert.match(build,/vla-icon-32\.png/);
  assert.match(build,/vla-icon-180\.png/);
  assert.match(generator,/for\(const size of \[32,180,512\]\)/);
});

test('build:public genera los assets sociales después del build allowlist',()=>{
  assert.equal(pkg.scripts['build:public'],'node scripts/build-production.js && node scripts/generate-social-card.js');
});
