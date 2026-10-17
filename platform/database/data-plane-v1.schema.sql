-- Regional Community Platform - Data Plane v1
-- Portable PostgreSQL/Supabase schema. No customer-specific rules belong here.

begin;

create schema if not exists app_private;
revoke all on schema app_private from public;

create table if not exists public.schema_metadata (
  component text primary key,
  version text not null,
  applied_at timestamptz not null default now()
);

insert into public.schema_metadata(component, version)
values ('data-plane', '1.0.0')
on conflict (component) do update set version = excluded.version, applied_at = now();

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  legal_name text not null,
  display_name text not null,
  country_code varchar(2) not null check (country_code ~ '^[A-Z]{2}$'),
  timezone text not null,
  primary_currency varchar(3) not null check (primary_currency ~ '^[A-Z]{3}$'),
  secondary_currency varchar(3) null check (secondary_currency is null or secondary_currency ~ '^[A-Z]{3}$'),
  country_pack_version text not null,
  status text not null default 'onboarding' check (status in ('onboarding','active','suspended','archived')),
  branding jsonb not null default '{}'::jsonb check (jsonb_typeof(branding) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (secondary_currency is null or secondary_currency <> primary_currency),
  unique (id, country_code),
  unique (id, primary_currency)
);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  display_name text not null,
  site_type text not null default 'community' check (site_type in ('community','building','urbanization','complex','mixed')),
  timezone text null,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table if not exists public.structures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  site_id uuid not null,
  parent_structure_id uuid null,
  structure_type text not null check (structure_type in ('tower','block','sector','stage','floor','wing','cluster','other')),
  code text not null,
  display_name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, site_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, site_id) references public.sites(tenant_id, id) on delete cascade,
  foreign key (tenant_id, parent_structure_id) references public.structures(tenant_id, id) on delete restrict
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  site_id uuid not null,
  structure_id uuid null,
  code text not null,
  display_name text not null,
  unit_type text not null default 'residential' check (unit_type in ('house','apartment','office','commercial','parking','storage','parcel','residential','other')),
  ownership_coefficient numeric(18,10) null check (ownership_coefficient is null or ownership_coefficient >= 0),
  status text not null default 'active' check (status in ('active','inactive','archived')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, site_id) references public.sites(tenant_id, id) on delete restrict,
  foreign key (tenant_id, structure_id) references public.structures(tenant_id, id) on delete restrict
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  person_type text not null default 'natural' check (person_type in ('natural','organization')),
  display_name text not null,
  legal_name text null,
  document_type text null,
  document_number text null,
  status text not null default 'active' check (status in ('active','inactive','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create unique index if not exists people_document_unique
on public.people(tenant_id, document_type, document_number)
where document_type is not null and document_number is not null;

create table if not exists public.person_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  person_id uuid not null,
  contact_type text not null check (contact_type in ('email','phone','whatsapp','other')),
  contact_value text not null,
  normalized_value text not null,
  is_primary boolean not null default false,
  verified_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (tenant_id, person_id, contact_type, normalized_value),
  foreign key (tenant_id, person_id) references public.people(tenant_id, id) on delete cascade
);

create table if not exists public.user_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null,
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id),
  unique (tenant_id, person_id, auth_user_id),
  foreign key (tenant_id, person_id) references public.people(tenant_id, id) on delete cascade
);

create table if not exists public.tenant_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('tenant_owner','tenant_admin','accountant','payment_reviewer','security_operator','board_member','read_only_auditor','support_admin')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  unique (tenant_id, auth_user_id, role)
);

create table if not exists public.unit_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  person_id uuid not null,
  role text not null check (role in ('owner','co_owner','tenant','resident','representative','authorized')),
  effective_from date not null default current_date,
  effective_to date null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (tenant_id, unit_id, person_id, role, effective_from),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete cascade,
  foreign key (tenant_id, person_id) references public.people(tenant_id, id) on delete cascade
);

create table if not exists public.tenant_policy_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version integer not null check (version > 0),
  country_pack_version text not null,
  status text not null check (status in ('draft','active','retired')),
  effective_from timestamptz null,
  policy jsonb not null check (jsonb_typeof(policy) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id, version)
);

create unique index if not exists one_active_policy_per_tenant
on public.tenant_policy_versions(tenant_id)
where status = 'active';

create table if not exists public.financial_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (code ~ '^[0-9]{4}-[0-9]{2}$'),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'open' check (status in ('open','closing','closed','locked')),
  closed_at timestamptz null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table if not exists public.charge_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  label text not null,
  category text not null check (category in ('ordinary','extraordinary','fund','service','penalty','adjustment','other')),
  allocation_mode text not null default 'fixed' check (allocation_mode in ('fixed','coefficient','equal_parts','consumption','manual')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table if not exists public.charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  period_id uuid not null,
  charge_type_id uuid not null,
  currency_code varchar(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric(20,6) not null check (amount > 0),
  description text null,
  due_date date not null,
  status text not null default 'issued' check (status in ('draft','issued','voided')),
  idempotency_key text not null,
  issued_at timestamptz null,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, unit_id, id),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict,
  foreign key (tenant_id, period_id) references public.financial_periods(tenant_id, id) on delete restrict,
  foreign key (tenant_id, charge_type_id) references public.charge_types(tenant_id, id) on delete restrict
);

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  label text not null,
  provider_type text not null check (provider_type in ('bank_transfer','instant_payment','card','wallet','cash','crypto','manual','other')),
  currency_code varchar(3) null check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  public_instructions jsonb not null default '{}'::jsonb check (jsonb_typeof(public_instructions) = 'object'),
  secret_reference text null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table if not exists public.payment_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  payment_method_id uuid not null,
  reported_by_auth_user_id uuid not null references auth.users(id) on delete restrict,
  currency_code varchar(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  reported_amount numeric(20,6) not null check (reported_amount > 0),
  reported_paid_at timestamptz null,
  external_reference text null,
  proof_object_path text null,
  state text not null default 'pending' check (state in ('pending','under_review','accepted','rejected','cancelled')),
  idempotency_key text not null,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz null,
  decided_by uuid null references auth.users(id) on delete set null,
  decision_reason text null,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, unit_id, id),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict,
  foreign key (tenant_id, payment_method_id) references public.payment_methods(tenant_id, id) on delete restrict
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  payment_report_id uuid null,
  payment_method_id uuid not null,
  currency_code varchar(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric(20,6) not null check (amount > 0),
  paid_at timestamptz not null,
  external_reference text null,
  status text not null default 'confirmed' check (status in ('confirmed','reversed')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, unit_id, id),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict,
  foreign key (tenant_id, unit_id, payment_report_id) references public.payment_reports(tenant_id, unit_id, id) on delete restrict,
  foreign key (tenant_id, payment_method_id) references public.payment_methods(tenant_id, id) on delete restrict
);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  payment_id uuid not null,
  charge_id uuid not null,
  payment_currency varchar(3) not null check (payment_currency ~ '^[A-Z]{3}$'),
  charge_currency varchar(3) not null check (charge_currency ~ '^[A-Z]{3}$'),
  payment_amount numeric(20,6) not null check (payment_amount > 0),
  charge_amount numeric(20,6) not null check (charge_amount > 0),
  exchange_rate numeric(24,10) null check (exchange_rate is null or exchange_rate > 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, payment_id, charge_id),
  foreign key (tenant_id, unit_id, payment_id) references public.payments(tenant_id, unit_id, id) on delete restrict,
  foreign key (tenant_id, unit_id, charge_id) references public.charges(tenant_id, unit_id, id) on delete restrict
);

create table if not exists public.credit_memos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  currency_code varchar(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric(20,6) not null check (amount > 0),
  reason text not null,
  status text not null default 'issued' check (status in ('issued','reversed')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id, idempotency_key),
  unique (tenant_id, unit_id, id),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  period_id uuid null,
  currency_code varchar(3) not null check (currency_code ~ '^[A-Z]{3}$'),
  amount numeric(20,6) not null check (amount <> 0),
  entry_kind text not null check (entry_kind in ('opening','charge','payment','credit','adjustment','reversal')),
  source_type text not null,
  source_id uuid not null,
  source_line_key text not null default 'main',
  effective_at timestamptz not null,
  reversal_of uuid null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid null references auth.users(id) on delete set null,
  unique (tenant_id, source_type, source_id, source_line_key),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict,
  foreign key (tenant_id, period_id) references public.financial_periods(tenant_id, id) on delete restrict,
  foreign key (tenant_id, reversal_of) references public.ledger_entries(tenant_id, id) on delete restrict
);

comment on column public.ledger_entries.amount is 'Signed amount. Positive increases amount due; negative increases payment/credit. Balances never net across currencies.';

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  payment_id uuid not null,
  receipt_number text not null,
  object_path text null,
  issued_at timestamptz not null default now(),
  voided_at timestamptz null,
  void_reason text null,
  unique (tenant_id, receipt_number),
  foreign key (tenant_id, unit_id, payment_id) references public.payments(tenant_id, unit_id, id) on delete restrict
);

create table if not exists public.access_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_code text not null,
  provider_kind text not null,
  public_config jsonb not null default '{}'::jsonb check (jsonb_typeof(public_config) = 'object'),
  secret_reference text null,
  status text not null default 'active' check (status in ('active','paused','disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider_code),
  unique (tenant_id, id)
);

create table if not exists public.access_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  integration_id uuid not null,
  unit_id uuid not null,
  person_id uuid null,
  external_credential_id text not null,
  credential_type text not null default 'account' check (credential_type in ('account','remote','card','tag','qr','plate','pin','other')),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and not (metadata ?| array['biometric','biometric_template','fingerprint','face_template','iris_template'])
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, integration_id, external_credential_id),
  unique (tenant_id, id),
  foreign key (tenant_id, integration_id) references public.access_integrations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete cascade,
  foreign key (tenant_id, person_id) references public.people(tenant_id, id) on delete restrict
);

create table if not exists public.access_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  integration_id uuid not null,
  credential_id uuid null,
  unit_id uuid null,
  event_type text not null check (event_type in ('granted','denied','opened','closed','enabled','disabled','sync','health','other')),
  direction text null check (direction is null or direction in ('entry','exit','unknown')),
  occurred_at timestamptz not null,
  provider_event_id text null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, integration_id) references public.access_integrations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, credential_id) references public.access_credentials(tenant_id, id) on delete restrict,
  foreign key (tenant_id, unit_id) references public.units(tenant_id, id) on delete restrict
);

create unique index if not exists access_events_provider_unique
on public.access_events(tenant_id, integration_id, provider_event_id)
where provider_event_id is not null;

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_auth_user_id uuid null references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid null,
  request_id text null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);

create or replace function app_private.reject_immutable_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception '% is append-only; create a reversal/correction event instead', tg_table_name
    using errcode = '55000';
end;
$$;

revoke all on function app_private.reject_immutable_mutation() from public;

create trigger ledger_entries_append_only
before update or delete on public.ledger_entries
for each row execute function app_private.reject_immutable_mutation();

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function app_private.reject_immutable_mutation();

create or replace view public.unit_currency_balances
with (security_invoker = true)
as
select
  tenant_id,
  unit_id,
  currency_code,
  sum(amount)::numeric(20,6) as balance,
  greatest(sum(amount), 0)::numeric(20,6) as amount_due,
  greatest(-sum(amount), 0)::numeric(20,6) as credit_available,
  max(effective_at) as last_activity_at
from public.ledger_entries
group by tenant_id, unit_id, currency_code;

create index if not exists units_tenant_site_idx on public.units(tenant_id, site_id);
create index if not exists user_identities_auth_idx on public.user_identities(auth_user_id, tenant_id) where status = 'active';
create index if not exists memberships_tenant_unit_idx on public.unit_memberships(tenant_id, unit_id);
create index if not exists memberships_person_idx on public.unit_memberships(tenant_id, person_id);
create index if not exists tenant_roles_user_idx on public.tenant_roles(auth_user_id, tenant_id) where revoked_at is null;
create index if not exists charges_unit_due_idx on public.charges(tenant_id, unit_id, due_date) where status = 'issued';
create index if not exists payment_reports_state_idx on public.payment_reports(tenant_id, state, submitted_at);
create index if not exists payments_unit_paid_idx on public.payments(tenant_id, unit_id, paid_at desc);
create index if not exists ledger_unit_currency_idx on public.ledger_entries(tenant_id, unit_id, currency_code, effective_at);
create index if not exists access_events_recent_idx on public.access_events(tenant_id, occurred_at desc);
create index if not exists audit_events_recent_idx on public.audit_events(tenant_id, occurred_at desc);

commit;
