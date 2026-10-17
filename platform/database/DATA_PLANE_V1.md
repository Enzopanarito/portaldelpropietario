# Data Plane v1

## Purpose

This is the portable customer-data layer for the regional community platform. It is designed to be installed in a dedicated Supabase/PostgreSQL project owned by, or transferable to, a condominium or property-management organization.

The Mac mini is only a development/test workstation. Git/Supabase remain the intended durable sources of truth.

## Core decisions

- PostgreSQL is canonical.
- Every business row is tenant-scoped directly or through tenant-scoped foreign keys.
- A project may host one condominium or multiple condominiums managed by the same organization.
- Financial balances are derived from immutable ledger entries, never from an editable balance field.
- Ledger balances remain separate per currency; the database does not silently net USD, VES, COP, BRL, etc.
- Canonical financial writes are server-side. Authenticated residents receive read access plus a narrow INSERT permission for payment reports.
- RLS is enabled on every exposed table.
- Data API grants are explicit because new Supabase projects no longer automatically expose new public tables.
- Authorization uses DB relationships and auth.uid(), never user-editable metadata.
- No SECURITY DEFINER helper functions are used.
- Views exposed to users use security_invoker.
- Raw biometric templates are prohibited from the generic credential metadata.
- Ledger and audit events are append-only. Corrections happen through reversal/correction events.

## Main model

Identity and structure:

- tenants
- sites
- structures
- units
- people
- person_contacts
- user_identities
- tenant_roles
- unit_memberships

Configuration:

- tenant_policy_versions
- financial_periods
- charge_types
- payment_methods

Finance:

- charges
- payment_reports
- payments
- payment_allocations
- credit_memos
- ledger_entries
- unit_currency_balances (security-invoker view)
- receipts

Access and audit:

- access_integrations
- access_credentials
- access_events
- audit_events

## Financial convention

ledger_entries.amount is signed:

- positive: increases amount due;
- negative: increases payment/credit.

Example for one unit:

- USD +100 charge
- USD -40 payment
- VES +1,000 charge

The result is two independent balances:

- USD due: 60
- VES due: 1,000

There is intentionally no cross-currency payable-total view in the database.

## RLS model

Residents are linked to people through user_identities and then to units through unit_memberships.

Administrative access is explicit through tenant_roles. Initial roles are:

- tenant_owner
- tenant_admin
- accountant
- payment_reviewer
- security_operator
- board_member
- read_only_auditor
- support_admin

Being authenticated is never enough to read another tenant's rows.

## Supabase compatibility

The SQL intentionally avoids relying on automatic Data API grants. Authenticated grants are explicit and still sit behind RLS.

The schema assumes Supabase auth.users/auth.uid() exist. Local PostgreSQL tests use small stubs for those two Supabase primitives.

## Validation completed locally

Validated against PostgreSQL 17 in Docker:

1. schema applies successfully;
2. RLS/grants apply successfully;
3. resident A sees only tenant A;
4. resident A cannot submit a payment report for tenant B;
5. USD/VES balances remain separate;
6. ledger UPDATE is rejected;
7. existing MKJ adapter tests remain independent from this schema.

Before applying to a real Supabase project:

1. create/select a free development project in the explicitly chosen organization;
2. apply schema and RLS with the Supabase tools;
3. run security and performance advisors;
4. execute RLS tests with real Supabase Auth users;
5. only then generate the official migration using the Supabase migration workflow.
