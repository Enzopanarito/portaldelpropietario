'use strict';

const assert=require('assert');
const {sanitizeQueueJobForBackup}=require('../netlify/functions/airtable-backup')._test;

const entry={
  etag:'"etag-1"',
  metadata:{jobId:'WA-20260712-ABCDEF1234567890',revision:4},
  job:{
    jobId:'WA-20260712-ABCDEF1234567890',
    revision:4,
    lease:{deviceId:'mac-enzo',token:'a'.repeat(48),claimedAt:'2026-07-12T12:00:00.000Z',expiresAt:'2026-07-12T12:02:00.000Z'},
    messages:[{messageId:'MSG-01',phone:'+584141234567',message:'Texto exacto'}]
  }
};
const backup=sanitizeQueueJobForBackup(entry);
assert.strictEqual(backup.key,'jobs/WA-20260712-ABCDEF1234567890.json');
assert.strictEqual(backup.etag,'"etag-1"');
assert.strictEqual(backup.job.lease.token,undefined);
assert.strictEqual(backup.job.lease.restoreRequiresNewLease,true);
assert.strictEqual(entry.job.lease.token,'a'.repeat(48),'El respaldo no debe mutar la cola viva.');
assert.strictEqual(backup.job.messages[0].message,'Texto exacto');
assert.strictEqual(JSON.stringify(backup).includes('a'.repeat(48)),false,'No debe exportar el token de reserva.');

console.log('MESSAGING_BACKUP_TESTS_OK');
