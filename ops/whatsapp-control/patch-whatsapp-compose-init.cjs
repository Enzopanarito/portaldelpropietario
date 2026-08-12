'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = '# VLA_PLAYWRIGHT_INIT_V1';

function patchSource(input) {
  let source = String(input || '');
  if (!source.trim()) throw new Error('docker-compose.whatsapp.yml está vacío.');
  if (source.includes(MARKER)) return source;
  if (!/services:\s*[\r\n]+\s{2}whatsapp-agent:/m.test(source)) throw new Error('No se encontró el servicio whatsapp-agent.');
  const restart = /^    restart:\s*unless-stopped\s*$/m;
  if (!restart.test(source)) throw new Error('No se encontró restart: unless-stopped en whatsapp-agent.');
  source = source.replace(restart, match => `${match}\n    init: true ${MARKER}`);
  if (!source.includes('    init: true ' + MARKER)) throw new Error('No fue posible activar init en whatsapp-agent.');
  return source;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('Uso: node patch-whatsapp-compose-init.cjs /ruta/docker-compose.whatsapp.yml'); process.exit(2); }
  const full = path.resolve(target);
  const before = fs.readFileSync(full, 'utf8');
  const after = patchSource(before);
  if (after === before) { console.log(`${MARKER} ya estaba aplicado.`); process.exit(0); }
  fs.writeFileSync(full, after, 'utf8');
  console.log(`${MARKER} aplicado correctamente.`);
}

module.exports = { MARKER, patchSource };
