'use strict';

const expected=Object.freeze(require('../../../release.json'));

function compareReleaseContracts(actual){
  const received=actual&&typeof actual==='object'&&!Array.isArray(actual)?actual:{};
  const keys=[...new Set([...Object.keys(expected),...Object.keys(received)])].sort();
  const differences=keys.filter(key=>!Object.prototype.hasOwnProperty.call(expected,key)||!Object.prototype.hasOwnProperty.call(received,key)||JSON.stringify(expected[key])!==JSON.stringify(received[key])).map(key=>({key,expected:Object.prototype.hasOwnProperty.call(expected,key)?expected[key]:'<ausente>',actual:Object.prototype.hasOwnProperty.call(received,key)?received[key]:'<ausente>'}));
  return{ok:differences.length===0,differences,keys};
}

function deploymentMetadata(env=process.env){
  return{commit:String(env.COMMIT_REF||'').trim()||null,deployId:String(env.DEPLOY_ID||'').trim()||null,context:String(env.CONTEXT||'').trim()||null,release:expected.release};
}

module.exports={expected,compareReleaseContracts,deploymentMetadata};
