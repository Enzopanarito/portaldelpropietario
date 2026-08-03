'use strict';

const original = require('./_payment_proof_store');

function metadataOptions(options = {}) {
  return options.metadata ? { metadata: options.metadata } : undefined;
}

async function currentEntry(store, key, type) {
  return store.getWithMetadata(key, { type });
}

function adaptStore(store) {
  return {
    get(key, options) {
      return store.get(key, options);
    },
    getWithMetadata(key, options) {
      return store.getWithMetadata(key, options);
    },
    async set(key, data, options = {}) {
      const existing = await currentEntry(store, key, 'arrayBuffer');
      if (options.onlyIfNew && existing) {
        return { modified: false, etag: existing.etag || '' };
      }
      if (options.onlyIfMatch && (!existing || existing.etag !== options.onlyIfMatch)) {
        return { modified: false, etag: existing?.etag || '' };
      }
      await store.set(key, data, metadataOptions(options));
      const saved = await currentEntry(store, key, 'arrayBuffer');
      return { modified: true, etag: saved?.etag || '' };
    },
    async setJSON(key, data, options = {}) {
      const existing = await currentEntry(store, key, 'json');
      if (options.onlyIfNew && existing) {
        return { modified: false, etag: existing.etag || '' };
      }
      if (options.onlyIfMatch && (!existing || existing.etag !== options.onlyIfMatch)) {
        return { modified: false, etag: existing?.etag || '' };
      }
      await store.setJSON(key, data, metadataOptions(options));
      const saved = await currentEntry(store, key, 'json');
      return { modified: true, etag: saved?.etag || '' };
    },
    delete(key) {
      return store.delete(key);
    }
  };
}

async function defaultCompatStore() {
  const { getStore } = await import('@netlify/blobs');
  return adaptStore(getStore(original.STORE_NAME, { consistency: 'strong' }));
}

function createProofStore(options = {}) {
  return original.createProofStore({
    ...options,
    storeFactory: options.storeFactory || defaultCompatStore
  });
}

module.exports = {
  ...original,
  adaptStore,
  createProofStore
};
