'use strict';

const { AccessProvider } = require('../core/access-provider');

function defaultClient() {
  return require('../../netlify/functions/_shared/_mkj_client');
}

class MkjAccessProvider extends AccessProvider {
  constructor({ client = defaultClient() } = {}) {
    super({
      id: 'mkj',
      kind: 'cloud-access-control',
      capabilities: ['credential-state', 'credential-list', 'membership-recovery', 'idempotent-state-change']
    });
    this.client = client;
  }

  async setCredentialState({ externalCredentialId, enabled, email } = {}) {
    const memberId = String(externalCredentialId || '').trim();
    if (!memberId) throw Object.assign(new Error('externalCredentialId is required'), { code: 'ACCESS_CREDENTIAL_ID_REQUIRED' });
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be boolean'), { code: 'ACCESS_STATE_REQUIRED' });
    const action = enabled ? 'enable' : 'disable';
    const result = await this.client.mkjSetMemberStatus(memberId, action, { email });
    return {
      provider: this.id,
      externalCredentialId: String(result.resolvedMemberId || memberId),
      enabled,
      idempotent: Boolean(result.idempotent),
      recoveredCredentialId: Boolean(result.recoveredMemberId),
      providerStatus: result.providerStatus ?? result.status ?? null
    };
  }

  async listCredentials() {
    const result = await this.client.listOrganizationUsers();
    return (result.users || []).map(user => ({
      externalCredentialId: String(this.client.organizationUserId(user) || ''),
      email: String(this.client.organizationUserEmail(user) || ''),
      raw: user
    }));
  }

  async healthCheck() {
    try {
      const result = await this.client.listOrganizationUsers();
      return { ok: true, provider: this.id, kind: this.kind, credentialCount: (result.users || []).length };
    } catch (error) {
      return { ok: false, provider: this.id, kind: this.kind, code: error?.code || 'MKJ_HEALTH_FAILED' };
    }
  }
}

module.exports = { MkjAccessProvider };
