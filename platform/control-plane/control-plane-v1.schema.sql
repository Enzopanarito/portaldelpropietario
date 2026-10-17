-- Regional Community Platform - Control Plane v1
-- Company/JV metadata only. No resident financial records belong here.

begin;

create schema if not exists platform_control;
revoke all on schema platform_control from public, anon, authenticated;
grant usage on schema platform_control to service_role;

create table if not exists platform_control.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  display_name text not null,
  legal_name text null,
  country_code varchar(2) not null check (country_code ~ '^[A-Z]{2}$'),
  country_pack_version text not null,
  status text not null default 'onboarding' check (status in ('onboarding','active','suspended','offboarding','archived')),
  commercial_owner text not null default 'platform' check (commercial_owner in ('platform','distributor','direct')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists platform_control.tenant_domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform_control.tenants(id) on delete cascade,
  hostname text not null unique check (hostname = lower(hostname) and hostname !~ '[/:]'),
  is_primary boolean not null default false,
  status text not null default 'pending' check (status in ('pending','verified','disabled')),
  verified_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (tenant_id, hostname)
);

create unique index if not exists one_primary_verified_domain_per_tenant
on platform_control.tenant_domains(tenant_id)
where is_primary and status = 'verified';

create table if not exists platform_control.encrypted_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references platform_control.tenants(id) on delete cascade,
  purpose text not null,
  key_version text not null,
  algorithm text not null default 'AES-256-GCM' check (algorithm = 'AES-256-GCM'),
  iv_b64 text not null,
  auth_tag_b64 text not null,
  ciphertext_b64 text not null,
  aad_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz null,
  revoked_at timestamptz null,
  check (aad_hash ~ '^[0-9a-f]{64}$'),
  unique (tenant_id, purpose, key_version, id),
  unique (tenant_id, id)
);

create table if not exists platform_control.data_planes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references platform_control.tenants(id) on delete cascade,
  provider text not null default 'supabase' check (provider = 'supabase'),
  project_ref text not null unique check (project_ref ~ '^[a-z0-9]{20}$'),
  project_url text not null,
  publishable_key text not null check (publishable_key like 'sb_publishable_%'),
  region text null,
  ownership_mode text not null check (ownership_mode in ('platform_owned','client_owned','client_admin_owned')),
  connection_mode text not null check (connection_mode in ('project_claim','oauth_connected','platform_managed','client_managed')),
  management_oauth_secret_id uuid null,
  database_password_secret_id uuid null,
  migration_mode text not null default 'client_managed' check (migration_mode in ('platform_api','database_password','client_managed')),
  schema_version text not null default '0.0.0',
  edge_bundle_version text null,
  lifecycle_status text not null default 'provisioning' check (lifecycle_status in ('provisioning','healthy','degraded','paused','transferred','disconnected','retired')),
  last_health_at timestamptz null,
  transferred_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (project_url ~ '^https://[^/]+/?$'),
  check (management_oauth_secret_id is distinct from database_password_secret_id),
  foreign key (tenant_id, management_oauth_secret_id) references platform_control.encrypted_secrets(tenant_id, id) on delete restrict,
  foreign key (tenant_id, database_password_secret_id) references platform_control.encrypted_secrets(tenant_id, id) on delete restrict
);

create table if not exists platform_control.distributors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  display_name text not null,
  country_code varchar(2) null check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  status text not null default 'active' check (status in ('active','suspended','retired')),
  created_at timestamptz not null default now()
);

create table if not exists platform_control.tenant_distributors (
  tenant_id uuid not null references platform_control.tenants(id) on delete cascade,
  distributor_id uuid not null references platform_control.distributors(id) on delete restrict,
  relationship text not null check (relationship in ('seller','installer','support','account_owner')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (tenant_id, distributor_id, relationship)
);

create table if not exists platform_control.release_compatibility (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform_control.tenants(id) on delete cascade,
  web_release text not null,
  minimum_schema_version text not null,
  desired_schema_version text not null,
  desired_edge_bundle_version text null,
  status text not null default 'pending' check (status in ('pending','compatible','upgrade_required','blocked')),
  checked_at timestamptz null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  unique (tenant_id, web_release)
);

create table if not exists platform_control.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references platform_control.tenants(id) on delete cascade,
  actor_type text not null check (actor_type in ('platform','operator','distributor','tenant','automation')),
  actor_id text null,
  action text not null,
  entity_type text not null,
  entity_id text null,
  request_id text null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now()
);

create or replace function platform_control.reject_immutable_mutation()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

revoke all on function platform_control.reject_immutable_mutation() from public, anon, authenticated;
grant execute on function platform_control.reject_immutable_mutation() to service_role;

create trigger platform_control_audit_append_only
before update or delete on platform_control.audit_events
for each row execute function platform_control.reject_immutable_mutation();

alter table platform_control.tenants enable row level security;
alter table platform_control.tenant_domains enable row level security;
alter table platform_control.encrypted_secrets enable row level security;
alter table platform_control.data_planes enable row level security;
alter table platform_control.distributors enable row level security;
alter table platform_control.tenant_distributors enable row level security;
alter table platform_control.release_compatibility enable row level security;
alter table platform_control.audit_events enable row level security;

create policy control_tenants_deny_client on platform_control.tenants for all to anon, authenticated using (false) with check (false);
create policy control_domains_deny_client on platform_control.tenant_domains for all to anon, authenticated using (false) with check (false);
create policy control_secrets_deny_client on platform_control.encrypted_secrets for all to anon, authenticated using (false) with check (false);
create policy control_data_planes_deny_client on platform_control.data_planes for all to anon, authenticated using (false) with check (false);
create policy control_distributors_deny_client on platform_control.distributors for all to anon, authenticated using (false) with check (false);
create policy control_tenant_distributors_deny_client on platform_control.tenant_distributors for all to anon, authenticated using (false) with check (false);
create policy control_release_deny_client on platform_control.release_compatibility for all to anon, authenticated using (false) with check (false);
create policy control_audit_deny_client on platform_control.audit_events for all to anon, authenticated using (false) with check (false);

revoke all on all tables in schema platform_control from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema platform_control to service_role;
revoke update, delete on platform_control.audit_events from service_role;
grant insert, select on platform_control.audit_events to service_role;

create index if not exists tenant_domains_tenant_idx on platform_control.tenant_domains(tenant_id);
create index if not exists encrypted_secrets_tenant_purpose_idx on platform_control.encrypted_secrets(tenant_id, purpose) where revoked_at is null;
create index if not exists data_planes_health_idx on platform_control.data_planes(lifecycle_status, last_health_at);
create index if not exists data_planes_management_secret_idx on platform_control.data_planes(tenant_id, management_oauth_secret_id);
create index if not exists data_planes_database_secret_idx on platform_control.data_planes(tenant_id, database_password_secret_id);
create index if not exists tenant_distributors_distributor_idx on platform_control.tenant_distributors(distributor_id, active);
create index if not exists release_compatibility_status_idx on platform_control.release_compatibility(status, checked_at);
create index if not exists platform_audit_recent_idx on platform_control.audit_events(tenant_id, occurred_at desc);

alter default privileges for role postgres in schema platform_control
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema platform_control
  revoke execute on functions from public, anon, authenticated;

commit;
