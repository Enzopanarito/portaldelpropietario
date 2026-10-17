-- Control Plane v1 incremental migration: resumable provisioning runs.
begin;

create table if not exists platform_control.provisioning_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid null references platform_control.tenants(id) on delete set null,
  tenant_slug text not null,
  idempotency_key text not null unique,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object'),
  status text not null default 'running' check (status in ('running','blocked','failed','completed','cancelled')),
  current_step_code text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  check (completed_at is null or status = 'completed')
);

create table if not exists platform_control.provisioning_step_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references platform_control.provisioning_runs(id) on delete cascade,
  step_code text not null,
  attempt integer not null check (attempt > 0),
  status text not null check (status in ('started','completed','failed','skipped')),
  error_code text null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default now(),
  unique (run_id, step_code, attempt, status)
);

create trigger provisioning_step_events_append_only
before update or delete on platform_control.provisioning_step_events
for each row execute function platform_control.reject_immutable_mutation();

alter table platform_control.provisioning_runs enable row level security;
alter table platform_control.provisioning_step_events enable row level security;

create policy control_provisioning_runs_deny_client
on platform_control.provisioning_runs for all to anon, authenticated using (false) with check (false);
create policy control_provisioning_steps_deny_client
on platform_control.provisioning_step_events for all to anon, authenticated using (false) with check (false);

revoke all on platform_control.provisioning_runs, platform_control.provisioning_step_events from public, anon, authenticated;
grant select, insert, update, delete on platform_control.provisioning_runs to service_role;
grant insert, select on platform_control.provisioning_step_events to service_role;

create index if not exists provisioning_runs_tenant_status_idx on platform_control.provisioning_runs(tenant_id, status, updated_at desc);
create index if not exists provisioning_runs_slug_status_idx on platform_control.provisioning_runs(tenant_slug, status, updated_at desc);
create index if not exists provisioning_step_events_run_idx on platform_control.provisioning_step_events(run_id, occurred_at, step_code);

commit;
