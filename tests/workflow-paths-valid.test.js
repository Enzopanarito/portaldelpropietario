'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');

test('cada ruta JavaScript citada por los workflows existe en el mismo commit',()=>{
  const workflowDir=path.join(root,'.github','workflows');
  const missing=[];
  for(const name of fs.readdirSync(workflowDir).filter(file=>/\.ya?ml$/i.test(file))){
    const source=fs.readFileSync(path.join(workflowDir,name),'utf8');
    const references=new Set(source.match(/netlify\/functions\/[A-Za-z0-9_./-]+\.js/g)||[]);
    for(const reference of references){
      if(!fs.existsSync(path.join(root,reference)))missing.push(`${name}: ${reference}`);
    }
  }
  assert.deepEqual(missing,[],`Rutas inexistentes en GitHub Actions:\n${missing.join('\n')}`);
});
