# Vercel Regional Deployment Architecture

## Decision

The commercial regional platform targets Vercel for web delivery and server orchestration. Netlify remains a legacy dependency of the current VLA production system only and is not part of the regional platform contract.

The existing personal Vercel Hobby team is not a commercial deployment target. The production platform must live in a separate Vercel team owned by the future operating company/JV, with a plan that permits commercial use.

## Do not create one Vercel project per condominium

The scalable topology is one regional application per lifecycle/environment, not one application deployment per customer.

```text
Company/JV Vercel team
  Regional Platform Web
    tenant-a.example.com
    tenant-b.example.com
    tenant-c.example.com
        |
        v
  Control Plane registry
        |
        +--> Tenant A -> dedicated Supabase project A
        +--> Tenant B -> dedicated Supabase project B
        +--> Tenant C -> dedicated Supabase project C
```

Vercel serves and orchestrates the product. Each condominium's operational data remains isolated in its own Supabase Data Plane.

## Control Plane

The company-owned Control Plane contains platform-level metadata only, for example:

- tenant slug and status;
- country and Country Pack version;
- subscription/licensing state;
- distributor/installer relationship;
- safe Data Plane bootstrap metadata;
- integration capability flags;
- deployment and schema version state.

It must not become a shadow copy of resident financial data.

## Data Plane

Each condominium or property-management organization may own a dedicated Supabase project containing:

- residents and units;
- charges, payments, allocations and immutable ledger entries;
- receipts and payment-proof metadata;
- access credentials by external identifier;
- access events and audit events;
- tenant-local configuration.

Projects may later be transferred to the customer organization without transferring our application source code.

## Browser bootstrap

A browser request resolves the tenant from a verified hostname or tenant slug. The platform may return only safe bootstrap values required by that tenant's client session, such as:

- Supabase project URL;
- publishable key;
- tenant public ID/slug;
- auth storage namespace;
- enabled public capabilities.

Secret/service-role keys, provider passwords, OAuth client secrets and hardware credentials are server-only and are never returned in tenant bootstrap responses.

## Server-side writes

Canonical finance, access automation and administrative writes execute server-side. The long-term regional design should use a company-owned authorization/control mechanism such as Supabase-for-Platforms OAuth and/or an encrypted secret store. Do not place hundreds of customer service-role keys in frontend configuration.

For the first isolated pilot, server credentials may be provisioned specifically for that pilot environment, but the application interface must already treat credentials as tenant-resolved secret references rather than hard-coded values.

## Vercel environments

Use one Git-connected Vercel project for the platform application when the company team is created:

- production: protected production branch;
- preview: branch/PR deployments;
- development: local or approved development deployments.

A separate staging project is optional only if operational isolation later justifies it. Avoid multiplying Vercel projects for every test, client or temporary probe.

## Regions

Static assets remain globally distributed. Server execution region should be selected close to the relevant Control Plane and dominant pilot traffic. Country-specific or multi-region server execution can be added when measured latency or regulatory requirements justify it.

## Cost rule

Development stays free while practical. The current commercial app is not deployed into the personal Hobby team. Vercel commercial billing starts only when an appropriate company/JV team and real pilot/client require it; that infrastructure cost becomes part of commercial pricing.

## Portability rule

Business logic must remain platform-neutral. Vercel provides web/runtime delivery; it must not become the canonical financial store. PostgreSQL/Supabase remains canonical for operational data, and Git remains canonical for source and migrations.
