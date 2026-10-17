# Control Plane v1

## Purpose

The Control Plane belongs to the operating company/JV. It routes and manages the regional product but is intentionally not the canonical store for condominium financial or resident records.

Production topology keeps the Control Plane separate from each customer's Data Plane. The current free development project may host both schemas temporarily only to validate architecture without incurring infrastructure cost.

## What belongs here

- tenant identity, country and Country Pack version;
- verified hostnames;
- Supabase project reference, project URL and publishable key;
- Data Plane ownership and connection mode;
- schema/function compatibility versions;
- distributor/installer relationships;
- encrypted references required to manage a customer-owned Supabase project;
- deterministic provisioning runs and append-only provisioning step events;
- platform audit events.

## What never belongs here

- unit balances;
- charges, payments or receipts;
- payment proofs;
- resident identity/contact records;
- access event history for residents;
- biometric templates;
- raw provider passwords or OAuth tokens in plaintext.

## Customer ownership modes

`platform_owned` is appropriate during initial provisioning or a pilot before transfer.

`client_owned` means the condominium owns its Supabase organization/project.

`client_admin_owned` means a property-management company owns the project on behalf of one or more communities under its administration.

## Supabase claim and OAuth flow

The preferred long-term onboarding path is:

1. provision and validate a Data Plane;
2. install the approved schema/functions;
3. run security/performance checks;
4. allow the customer to claim/transfer the project to its Supabase organization;
5. retain explicitly authorized Management API access through a Supabase OAuth integration;
6. store only encrypted OAuth credentials/reference material in the company Control Plane.

Supabase's current OAuth integration is for Management API access. Current documentation still notes limitations for full database access on customer-owned projects; direct database access may require the database password. Therefore the platform must not assume OAuth alone grants arbitrary SQL execution.

`migration_mode` records that reality explicitly:

- `platform_api`: use an approved platform/migration API when available;
- `database_password`: use an encrypted customer-authorized database credential;
- `client_managed`: customer/admin executes or approves database migration through its own controlled process.

No migration path may silently downgrade into another one.

## Privileged business operations

Ordinary resident reads use the tenant Data Plane's publishable key plus Supabase Auth/RLS.

Narrow writes that are safe under RLS, such as submitting a pending payment report, may go directly to the Data Plane.

Canonical financial mutations, access automation and other privileged operations must execute server-side. Prefer keeping tenant-specific privileged execution inside that tenant's Data Plane (for example approved Supabase Edge Functions) so service credentials do not need to accumulate in Vercel.

Vercel remains the regional web/control runtime, not the owner of customer financial data.

## Secret envelope

OAuth refresh tokens and any explicitly authorized database credentials are encrypted before database storage with AES-256-GCM. The encryption master key lives outside the Control Plane database, as a protected server secret. Each envelope is bound through authenticated additional data to tenant, purpose and key version so a ciphertext copied to another tenant fails authentication.

The schema stores ciphertext, IV, authentication tag, AAD hash and key version only. Rotation creates a new envelope and revokes the old one; plaintext is never stored.

## Client denial

Every Control Plane table has RLS enabled and an explicit deny policy for `anon` and `authenticated`. Grants are also revoked. Only trusted server-side `service_role` access is granted in v1. This is deliberate defense in depth.

## Provisioning runs

Every commercial tenant is provisioned from a validated, secret-free manifest. The Control Plane stores the manifest hash and deterministic plan, not credentials. `provisioning_runs.idempotency_key` prevents accidental duplicate onboarding, while `provisioning_step_events` is append-only so retries are auditable.

A failed step resumes at that same step with a higher attempt number. Completed prior steps are never silently repeated. This prevents a retry from creating duplicate Supabase projects, domains or tenant records.

## Release compatibility

The web application must never blindly assume a customer Data Plane is current. `release_compatibility` and `data_planes.schema_version` allow the Vercel runtime to block or degrade features when the Data Plane schema or privileged function bundle is older than the web release requires.
