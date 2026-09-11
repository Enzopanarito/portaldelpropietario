'use strict';

const blobs = require('./_blobs_compat');

const STORE_NAME = 'vla-communications-v1';
const INDEX_KEY = 'jobs/index';
const NOTICE_KEY = 'notice/current';

let nativeGetStore = null;
function configureNativeStore(getStore) { nativeGetStore = getStore; }
function store() {
  return nativeGetStore
    ? blobs.wrapStore(nativeGetStore({ name: STORE_NAME, consistency: 'strong' }))
    : blobs.getAtomicStore(STORE_NAME, { consistency: 'strong' });
}
function jobKey(jobId) { return `jobs/${String(jobId || '').replace(/[^A-Za-z0-9-]/g, '')}`; }
async function readJson(key) {
  const result = await store().getWithMetadata(key, { type: 'json' });
  return result?.data ?? result ?? null;
}
async function atomicCreate(key, value, metadata = {}) {
  return store().setJSON(key, value, { onlyIfNew: true, metadata });
}
async function updateJson(key, mutate, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    const current = await store().getWithMetadata(key, { type: 'json' });
    const data = current?.data ?? current ?? null;
    const next = mutate(data);
    const options = current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
    const result = await store().setJSON(key, next, options);
    if (result.modified) return next;
  }
  throw new Error('No fue posible actualizar el registro de comunicaciones por una colisión concurrente.');
}
async function createJob(job) {
  const created = await atomicCreate(jobKey(job.jobId), job, { status: job.status, createdAt: job.createdAt });
  if (!created.modified) return readJob(job.jobId);
  await updateJson(INDEX_KEY, current => ({
    version: 1,
    jobIds: [job.jobId, ...((current?.jobIds || []).filter(id => id !== job.jobId))].slice(0, 30),
    updatedAt: new Date().toISOString()
  }));
  return job;
}
async function readJob(jobId) { return readJson(jobKey(jobId)); }
async function claimJob(jobId) {
  try {
    const job = await updateJob(jobId, current => {
      if (!['QUEUED', 'RETRY_SAFE'].includes(current.status)) {
        const error = new Error('El comunicado ya fue reclamado.');
        error.code = 'COMMUNICATION_ALREADY_CLAIMED';
        throw error;
      }
      return { status: 'RUNNING', startedAt: new Date().toISOString(), error: null };
    });
    return { claimed: true, job };
  } catch (error) {
    if (error.code !== 'COMMUNICATION_ALREADY_CLAIMED') throw error;
    return { claimed: false, job: await readJob(jobId) };
  }
}
async function updateJob(jobId, patch) {
  return updateJson(jobKey(jobId), current => {
    if (!current) throw new Error('El comunicado no existe.');
    const nextPatch = typeof patch === 'function' ? patch(current) : patch;
    return { ...current, ...nextPatch, updatedAt: new Date().toISOString() };
  });
}
async function recentJobs(limit = 10) {
  const index = await readJson(INDEX_KEY);
  const ids = (index?.jobIds || []).slice(0, Math.max(1, Math.min(20, Number(limit) || 10)));
  return (await Promise.all(ids.map(readJob))).filter(Boolean);
}
async function readNotice() { return readJson(NOTICE_KEY); }
async function writeNotice(notice) { return updateJson(NOTICE_KEY, () => notice); }
function connect(event) { return blobs.connectLambdaEvent(event); }

module.exports = { STORE_NAME, INDEX_KEY, NOTICE_KEY, configureNativeStore, connect, readJob, createJob, claimJob, updateJob, recentJobs, readNotice, writeNotice, updateJson };
