'use strict';

const fs=require('fs');
const path=require('path');

const REQUIRED_KEYS=Object.freeze([
  'release',
  'expectedHouses',
  'balanceEngine',
  'publicDataEngine',
  'breakdownPresentation',
  'paymentReport'
]);

function readContract(filename){
  const resolved=path.resolve(filename);
  const parsed=JSON.parse(fs.readFileSync(resolved,'utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(`Contrato de release inválido: ${resolved}`);
  return parsed;
}

function compareContracts(expected,actual){
  const missing=REQUIRED_KEYS.filter(key=>!Object.prototype.hasOwnProperty.call(expected,key));
  if(missing.length)throw new Error(`release.json no contiene marcadores obligatorios: ${missing.join(', ')}`);
  const expectedKeys=Object.keys(expected).sort(),actualKeys=Object.keys(actual).sort();
  const keys=[...new Set([...expectedKeys,...actualKeys])].sort();
  const differences=[];
  for(const key of keys){
    if(!Object.prototype.hasOwnProperty.call(expected,key))differences.push({key,expected:'<ausente>',actual:actual[key]});
    else if(!Object.prototype.hasOwnProperty.call(actual,key))differences.push({key,expected:expected[key],actual:'<ausente>'});
    else if(JSON.stringify(expected[key])!==JSON.stringify(actual[key]))differences.push({key,expected:expected[key],actual:actual[key]});
  }
  return{ok:differences.length===0,differences,requiredKeys:[...REQUIRED_KEYS],comparedKeys:keys};
}

function main(argv=process.argv.slice(2)){
  if(argv.length!==2)throw new Error('Uso: node scripts/verify-release-contract.js <release-esperado.json> <release-produccion.json>');
  const expected=readContract(argv[0]),actual=readContract(argv[1]),result=compareContracts(expected,actual);
  if(!result.ok){
    console.error(JSON.stringify({event:'VLA_RELEASE_CONTRACT_MISMATCH',...result},null,2));
    process.exitCode=1;
    return result;
  }
  console.log(JSON.stringify({event:'VLA_RELEASE_CONTRACT_MATCH',release:expected.release,expectedHouses:expected.expectedHouses,comparedKeys:result.comparedKeys},null,2));
  return result;
}

if(require.main===module){
  try{main()}catch(error){console.error(error.message);process.exitCode=1}
}

module.exports={REQUIRED_KEYS,readContract,compareContracts,main};
