-- Hybrid SaaS: shared Supabase pools + dedicated projects.
-- Additive migration; legacy platform_control.data_planes remains for compatibility.
begin;

alter table platform_control.tenants
  add constraint tenants_id_country_unique unique (id, country_code);

create table platform_control.data_plane_pools (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'supabase' check (provider = 'supabase'),
  project_ref text not null unique check (project_ref ~ '^[a-z0-9]{20}$'),
  project_url text not null check (project_url ~ '^https://[^/]+/?$'),
  publishable_key text not null check (publishable_key like 'sb_publishable_%'),
  pool_mode text not null check (pool_mode in ('shared','dedicated')),
  country_code varchar(2) not null check (country_code ~ '^[A-Z]{2}$'),
  region text not null,
  ownership_mode text not null check (ownership_mode in ('platform_owned','client_owned','client_admin_owned')),
  schema_version text not null default '0.0.0',
  lifecycle_status text not null default 'provisioning'
    check (lifecycle_status in ('provisioning','healthy','degraded','paused','transferred','disconnected','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pool_mode = 'dedicated' or ownership_mode = 'platform_owned'),
  unique (id, country_code, pool_mode)
);

create table platform_control.tenant_pool_bindings (
  tenant_id uuid primary key,
  country_code varchar(2) not null,
  pool_id uuid not null,
  pool_mode text not null check (pool_mode in ('shared','dedicated')),
  status text not null default 'pending'
    check (status in ('pending','active','suspended','migrating','retired')),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, country_code)
    references platform_control.tenants(id, country_code) on delete cascade,
  foreign key (pool_id, country_code, pool_mode)
    references platform_control.data_plane_pools(id, country_code, pool_mode) on delete restrict
);

-- A dedicated project cannot be bound to two separate communities.
create unique index tenant_pool_only_one_dedicated
  on platform_control.tenant_pool_bindings(pool_id)
  where pool_mode = 'dedicated';

create index tenant_pool_bindings_pool_idx
  on platform_control.tenant_pool_bindings(pool_id, status);
create index data_plane_pools_capacity_idx
  on platform_control.data_plane_pools(country_code, pool_mode, lifecycle_status);

-- Preserve existing dedicated client mappings without re-creating any projects.
insert into platform_control.data_plane_pools (
  provider, project_ref, project_url, publishable_key, pool_mode,
  country_code, region, ownership_mode, schema_version, lifecycle_status
)
select d.provider, d.project_ref, d.project_url, d.publishable_key, 'dedicated',
       t.country_code, coalesce(d.region, 'us-east-1'), d.ownership_mode,
       d.schema_version, d.lifecycle_status
from platform_control.data_planes d
join platform_control.tenants t on t.id = d.tenant_id
on conflict (project_ref) do nothing;

insert into platform_control.tenant_pool_bindings (
  tenant_id, country_code, pool_id, pool_mode, status
)
select d.tenant_id, t.country_code, p.id, 'dedicated',
       case when d.lifecycle_status = 'healthy' then 'active' else 'pending' end
from platform_control.data_planes d
join platform_control.tenants t on t.id = d.tenant_id
join platform_control.data_plane_pools p on p.project_ref = d.project_ref
on conflict (tenant_id) do nothing;

alter table platform_control.data_plane_pools enable row level security;
alter table platform_control.tenant_pool_bindings enable row level security;
create policy control_pools_deny_client on platform_control.data_plane_pools
  for all to anon, authenticated using (false) with check (false);
create policy control_bindings_deny_client on platform_control.tenant_pool_bindings
  for all to anon, authenticated using (false) with check (false);
revoke all on platform_control.data_plane_pools, platform_control.tenant_pool_bindings
  from public, anon, authenticated;
grant select, insert, update, delete on
  platform_control.data_plane_pools, platform_control.tenant_pool_bindings to service_role;

commit;
