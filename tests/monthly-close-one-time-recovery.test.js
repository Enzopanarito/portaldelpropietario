'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('recuperación única de septiembre queda fecha-bloqueada y mes-bloqueada',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','netlify','functions','monthly-close-recovery-2026-09-background.js'),'utf8');
  assert.match(source,/TARGET_DATE='2026-10-01'/);
  assert.match(source,/TARGET_MONTH='2026-09'/);
  assert.match(source,/CONFIRMATION='CLOSE-SEPTEMBER-2026-NOW'/);
  assert.match(source,/one-time-close-recovery/);
  assert.match(source,/autopilot\.handler/);
});
