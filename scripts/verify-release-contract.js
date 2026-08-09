'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} no contiene un contrato JSON válido.`);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function contractDigest(contract) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(contract))).digest('hex');
}

function compareReleaseContracts(expected, actual) {
  const fields = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
  const differences = fields.flatMap(field => {
    if (!(field in expected)) return [{ field, reason: 'unexpected', actual: actual[field] }];
    if (!(field in actual)) return [{ field, reason: 'missing', expected: expected[field] }];
    const left = JSON.stringify(stable(expected[field]));
    const right = JSON.stringify(stable(actual[field]));
    return left === right ? [] : [{ field, reason: 'mismatch', expected: expected[field], actual: actual[field] }];
  });
  return {
    ok: differences.length === 0,
    fields,
    differences,
    expectedDigest: contractDigest(expected),
    actualDigest: contractDigest(actual)
  };
}

function shellOutput(contract) {
  const values = {
    release: contract.release,
    expected_houses: contract.expectedHouses,
    contract_digest: contractDigest(contract),
    contract_fields: Object.keys(contract).sort().join(',')
  };
  return Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '')}`).join('\n');
}

if (require.main === module) {
  const [mode, expectedFile, actualFile] = process.argv.slice(2);
  try {
    if (mode === 'github-output') {
      process.stdout.write(`${shellOutput(readJson(expectedFile))}\n`);
    } else if (mode === 'verify') {
      const result = compareReleaseContracts(readJson(expectedFile), readJson(actualFile));
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    } else {
      throw new Error('Uso: verify-release-contract.js github-output <release.json> | verify <esperado.json> <actual.json>');
    }
  } catch (error) {
    console.error(`RELEASE_CONTRACT_ERROR ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { compareReleaseContracts, contractDigest, readJson, shellOutput, stable };
