'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const workflow=fs.readFileSync(path.join(__dirname,'..','.github','workflows','monitor-vla-release-drift.yml'),'utf8');

test('monitor de drift corre cada hora y es de solo lectura sobre VLA',()=>{
  assert.match(workflow,/cron: '17 \* \* \* \*'/);
  assert.match(workflow,/villalosapamates\.netlify\.app/);
  assert.match(workflow,/vla-failover\.vercel\.app/);
  assert.match(workflow,/FAILOVER_COMMIT_DRIFT/);
  assert.match(workflow,/FAILOVER_RELEASE_DRIFT/);
  assert.match(workflow,/FAILOVER_WRITES_NOT_DISABLED/);
  assert.match(workflow,/FAILOVER_CLOSE_NOT_BLOCKED/);
  assert.doesNotMatch(workflow,/curl[^\n]*--request\s+(POST|PATCH|PUT|DELETE)/i);
  assert.doesNotMatch(workflow,/airtable\.com\/v0/i);
});

test('monitor abre un único incidente y lo cierra tras recuperación',()=>{
  assert.match(workflow,/gh issue list/);
  assert.match(workflow,/gh issue create/);
  assert.match(workflow,/gh issue close/);
  assert.match(workflow,/Incident issue #\$existing already open/);
});

test('monitor fija checkout por SHA',()=>{
  assert.match(workflow,/actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.doesNotMatch(workflow,/actions\/checkout@v\d+\b/);
});
