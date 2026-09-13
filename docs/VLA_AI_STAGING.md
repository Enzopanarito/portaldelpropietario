# VLA AI - Staging architecture

Status: **NOT DEPLOYED / NOT PUBLIC**

This branch introduces the first server-side contract for the future VLA conversational assistant. It is intentionally read-only and does not change the existing outbound WhatsApp system.

## Separation of responsibilities

- Existing Mac mini + n8n + WhatsApp Controller remains responsible for outbound reminders and broadcasts.
- VLA AI will use a different phone number through the official WhatsApp Cloud API.
- VLA AI only reacts to inbound owner messages. It has no scheduler, campaign sender, cron or outbound template logic.
- The agent itself will live in a separate private repository. No Meta, Chatwoot, Ollama or service secrets belong in this public repository.

## Read-only VLA service endpoint

`POST /.netlify/functions/vla-ai-context`

Required header:

`Authorization: Bearer <VLA_AI_SERVICE_SECRET>`

Required JSON body:

```json
{ "phone": "+584121234567" }
```

The endpoint is disabled unless `VLA_AI_SERVICE_SECRET` exists and contains at least 32 bytes. The secret must only exist in the runtime environment and must never be committed.

## Identity and privacy rules

1. Owner identity is resolved from the WhatsApp phone number against the phone fields stored in `Propietarios`.
2. Venezuelan mobile numbers are normalized to E.164 (`+58...`).
3. No match returns 404.
4. More than one matching house returns 409 and requires administrative verification.
5. The response includes data for exactly one owner. It never returns the owner directory.
6. Phone numbers are masked in responses.

## Current capabilities

The context can expose only the matched owner's:

- current USD and Bs-reference balances using the official balance engine;
- expired debt used by the gate-control rules;
- current gate status and reason;
- recent definitive payments;
- pending payment reports;
- plant participation/service context when that module is available.

The contract explicitly reports these as false:

- `canWrite`
- `canApprovePayments`
- `canReversePayments`
- `canChangeAccess`
- `canChangeDebt`
- `canInitiateWhatsApp`

## Production gate

Do not deploy this endpoint to production until all of the following are true:

- staging CI is green;
- owner phone data has been audited for unique matches;
- a private `vla-ai-agent` repository exists;
- Chatwoot, PostgreSQL, Redis and Ollama are running locally on the Mac mini;
- a new WhatsApp number has been verified in Meta;
- end-to-end tests pass with test owners;
- the administrator explicitly authorizes production activation.
