'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'netlify', 'functions');
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', '.netlify']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.html', '.toml', '.yml', '.yaml', '.json', '.md']);

function walk(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) output.push(full);
  }
  return output;
}

function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

const allFiles = walk(ROOT);
const corpus = allFiles.map(file => ({
  file,
  rel: path.relative(ROOT, file).replace(/\\/g, '/'),
  text: fs.readFileSync(file, 'utf8')
}));

const entries = fs.readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter(entry => entry.isFile() && ['.js', '.mjs', '.ts'].includes(path.extname(entry.name)))
  .map(entry => {
    const name = path.basename(entry.name, path.extname(entry.name));
    const ownRel = `netlify/functions/${entry.name}`;
    const references = [];
    for (const item of corpus) {
      if (item.rel === ownRel) continue;
      const routeRef = occurrences(item.text, `/.netlify/functions/${name}`);
      const targetRef = occurrences(item.text, `/${name}`);
      const requireRef = occurrences(item.text, `require('./${name}')`) + occurrences(item.text, `require("./${name}")`);
      const importRef = occurrences(item.text, `from './${name}'`) + occurrences(item.text, `from "./${name}"`);
      const total = routeRef + requireRef + importRef;
      if (total > 0) references.push({ file: item.rel, routeRef, requireRef, importRef });
      else if (item.rel === 'netlify.toml' && targetRef > 0) references.push({ file: item.rel, routeRef: targetRef, requireRef: 0, importRef: 0 });
    }
    const versioned = /(?:-v\d+|-modern|-scheduled|-background)$/.test(name);
    return { name, file: ownRel, versioned, references };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const likelyInternal = entries.filter(entry => entry.versioned && !entry.references.some(ref => ref.routeRef > 0));
const payload = {
  generatedAt: new Date().toISOString(),
  topLevelFunctions: entries.length,
  versionedOrRuntimeVariant: entries.filter(entry => entry.versioned).length,
  likelyInternalCount: likelyInternal.length,
  likelyInternal: likelyInternal.map(entry => ({ name: entry.name, references: entry.references })),
  entries
};

fs.writeFileSync(path.join(ROOT, 'function-surface-audit.json'), JSON.stringify(payload, null, 2));
console.log(`VLA_FUNCTION_SURFACE topLevel=${payload.topLevelFunctions} variants=${payload.versionedOrRuntimeVariant} likelyInternal=${payload.likelyInternalCount}`);
for (const item of likelyInternal) {
  const refs = item.references.map(ref => `${ref.file}:${ref.requireRef + ref.importRef}`).join(', ') || 'sin referencias detectadas';
  console.log(`VLA_FUNCTION_CANDIDATE ${item.name} <- ${refs}`);
}
