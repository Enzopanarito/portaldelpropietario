'use strict';

const fs = require('fs');
const path = require('path');

const INIT_MARKER = '# VLA_PLAYWRIGHT_INIT_V1';
const RECOVERY_MARKER = '# VLA_STARTUP_RECOVERY_OFF_V1';

function countMatches(source, regex) {
  return [...source.matchAll(regex)].length;
}

function patchSource(input) {
  let source = String(input || '');
  if (!source.trim()) throw new Error('docker-compose.whatsapp.yml está vacío.');
  if (!/services:\s*[\r\n]+\s{2}whatsapp-agent:/m.test(source)) throw new Error('No se encontró el servicio whatsapp-agent.');

  const initRegex = /^    init:\s*[^\r\n#]*(?:#.*)?$/gm;
  const initCount = countMatches(source, initRegex);
  if (initCount > 1) throw new Error('Hay más de una clave init en whatsapp-agent. Se bloquea para no adivinar.');
  if (initCount === 1) {
    source = source.replace(initRegex, `    init: true ${INIT_MARKER}`);
  } else {
    const restart = /^    restart:\s*unless-stopped\s*$/m;
    if (!restart.test(source)) throw new Error('No se encontró restart: unless-stopped en whatsapp-agent.');
    source = source.replace(restart, match => `${match}\n    init: true ${INIT_MARKER}`);
  }

  const recoveryRegex = /^      WA_STARTUP_RECOVERY:\s*[^\r\n#]*(?:#.*)?$/gm;
  const recoveryCount = countMatches(source, recoveryRegex);
  if (recoveryCount > 1) throw new Error('Hay más de una clave WA_STARTUP_RECOVERY en whatsapp-agent. Se bloquea para no ocultar una configuración ambigua.');
  if (recoveryCount === 1) {
    source = source.replace(recoveryRegex, `      WA_STARTUP_RECOVERY: "false" ${RECOVERY_MARKER}`);
  } else {
    const env = /^    environment:\s*$/m;
    if (!env.test(source)) throw new Error('No se encontró environment: en whatsapp-agent.');
    source = source.replace(env, match => `${match}\n      WA_STARTUP_RECOVERY: "false" ${RECOVERY_MARKER}`);
  }

  if (countMatches(source, /^    init:\s*/gm) !== 1) throw new Error('init no quedó definido exactamente una vez.');
  if (countMatches(source, /^      WA_STARTUP_RECOVERY:\s*/gm) !== 1) throw new Error('WA_STARTUP_RECOVERY no quedó definido exactamente una vez.');
  if (!source.includes(`    init: true ${INIT_MARKER}`)) throw new Error('No fue posible activar init en whatsapp-agent.');
  if (!source.includes(`      WA_STARTUP_RECOVERY: "false" ${RECOVERY_MARKER}`)) throw new Error('No fue posible fijar WA_STARTUP_RECOVERY=false.');
  return source;
}

if (require.main === module) {
  const target = process.argv[2];
  if (!target) { console.error('Uso: node patch-whatsapp-compose-init.cjs /ruta/docker-compose.whatsapp.yml'); process.exit(2); }
  const full = path.resolve(target);
  const before = fs.readFileSync(full, 'utf8');
  const after = patchSource(before);
  if (after === before) { console.log('VLA_PLAYWRIGHT_INIT_V1 y VLA_STARTUP_RECOVERY_OFF_V1 ya estaban aplicados.'); process.exit(0); }
  fs.writeFileSync(full, after, 'utf8');
  console.log('VLA_PLAYWRIGHT_INIT_V1 y VLA_STARTUP_RECOVERY_OFF_V1 aplicados correctamente.');
}

module.exports = { INIT_MARKER, RECOVERY_MARKER, patchSource };
