'use strict';

class AccessProvider {
  constructor({ id, kind, capabilities = [] } = {}) {
    if (!id) throw new Error('AccessProvider requires id');
    if (!kind) throw new Error('AccessProvider requires kind');
    this.id = String(id);
    this.kind = String(kind);
    this.capabilities = new Set(capabilities.map(String));
  }

  supports(capability) {
    return this.capabilities.has(String(capability));
  }

  async healthCheck() {
    return { ok: true, provider: this.id, kind: this.kind };
  }

  async setCredentialState() {
    throw Object.assign(new Error('setCredentialState is not implemented'), { code: 'ACCESS_PROVIDER_NOT_IMPLEMENTED' });
  }

  async listCredentials() {
    throw Object.assign(new Error('listCredentials is not implemented'), { code: 'ACCESS_PROVIDER_NOT_IMPLEMENTED' });
  }
}

module.exports = { AccessProvider };
