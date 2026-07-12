'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(root).filter(file => /\.(js|mjs|cjs|html)$/.test(file));
const results = [];
for (const file of files) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/api\.airtable\.com|AIRTABLE_API_TOKEN|AIRTABLE_BASE_ID|API_USAGE|airtable(?:Get|Create|Update|Delete|Fetch|Request)/i.test(line)) {
      results.push({ file: rel, line: index + 1, text: line.trim().slice(0, 500) });
    }
  });
}

const grouped = {};
for (const row of results) {
  (grouped[row.file] ||= []).push(row);
}
const summary = {
  generatedAt: new Date().toISOString(),
  filesWithAirtableReferences: Object.keys(grouped).length,
  directApiFiles: Object.entries(grouped).filter(([, rows]) => rows.some(row => row.text.includes('api.airtable.com'))).map(([file]) => file),
  usageMarkerFiles: Object.entries(grouped).filter(([, rows]) => rows.some(row => row.text.includes('API_USAGE'))).map(([file]) => file),
  grouped
};
fs.writeFileSync('airtable-call-inventory.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
