import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalize, stableStringify, sha256, sortRecords } = require('../netlify/functions/_shared/_integrity.js');
const { TABLES } = require('../netlify/functions/_shared/_backup_inventory.js');

function fail(message) {
  console.error(`VLA_BACKUP_VERIFY_FAILED ${message}`);
  process.exit(1);
}

const inputPath = process.argv[2];
const manifestPath = process.argv[3] || '';
if (!inputPath) fail('Falta ruta del backup JSON.');

let backup;
try { backup = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
catch (error) { fail(`JSON inválido: ${error.message}`); }

if (backup?.backupType !== 'airtable-full-operational-backup') fail('backupType inesperado.');
if (Number(backup?.schemaVersion) !== 3) fail('schemaVersion inesperado.');
if (Number(backup?.tableCount) !== TABLES.length) fail(`tableCount debe ser ${TABLES.length}.`);
if (!backup?.tables || typeof backup.tables !== 'object') fail('Faltan tables.');
if (!backup?.integrity || backup.integrity.algorithm !== 'SHA-256') fail('Integridad SHA-256 ausente.');

const actualNames = Object.keys(backup.tables).sort();
const expectedNames = [...TABLES].sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('Inventario de tablas no coincide con el canónico 12/12.');

const tableCounts = {};
const tableHashes = {};
let totalRecords = 0;
for (const tableName of TABLES) {
  const table = backup.tables[tableName];
  if (!table || !Array.isArray(table.records)) fail(`Tabla inválida: ${tableName}`);
  const sorted = sortRecords(table.records);
  const computedHash = sha256(sorted);
  const declaredHash = String(table.sha256 || '');
  const manifestTableHash = String(backup.integrity.tableHashes?.[tableName] || '');
  if (!/^[a-f0-9]{64}$/i.test(declaredHash) || computedHash !== declaredHash || computedHash !== manifestTableHash) {
    fail(`Hash inválido en ${tableName}.`);
  }
  if (Number(table.recordCount) !== sorted.length) fail(`recordCount inválido en ${tableName}.`);
  tableCounts[tableName] = sorted.length;
  tableHashes[tableName] = computedHash;
  totalRecords += sorted.length;
}

if (Number(backup.totalRecords) !== totalRecords) fail('totalRecords no coincide.');
const manifestInput = {
  backupType: backup.backupType,
  schemaVersion: backup.schemaVersion,
  generatedAt: backup.generatedAt,
  baseId: backup.baseId,
  tableCount: backup.tableCount,
  totalRecords: backup.totalRecords,
  tableHashes: backup.integrity.tableHashes
};
const manifestHash = sha256(manifestInput);
if (manifestHash !== backup.integrity.manifestHash) fail('manifestHash no coincide.');

const fileHashInput = {
  ...backup,
  integrity: { ...backup.integrity, fileContentHash: null }
};
const fileContentHash = sha256(fileHashInput);
if (fileContentHash !== backup.integrity.fileContentHash) fail('fileContentHash no coincide.');

const rawBytes = fs.readFileSync(inputPath);
const rawSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
const safeManifest = {
  backupType: backup.backupType,
  schemaVersion: backup.schemaVersion,
  generatedAt: backup.generatedAt,
  generatedAtCaracas: backup.generatedAtCaracas,
  tableCount: backup.tableCount,
  totalRecords,
  tableCounts,
  integrity: {
    algorithm: 'SHA-256',
    manifestHash,
    fileContentHash,
    rawFileSha256: rawSha256
  },
  verification: {
    inventory: `${TABLES.length}/${TABLES.length}`,
    hashes: `${TABLES.length}/${TABLES.length}`,
    result: 'PASS'
  }
};

if (manifestPath) fs.writeFileSync(manifestPath, JSON.stringify(canonicalize(safeManifest), null, 2));
console.log(`VLA_BACKUP_VERIFY_OK tables=${TABLES.length}/${TABLES.length} records=${totalRecords} manifest=${manifestHash}`);
