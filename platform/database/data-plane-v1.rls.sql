-- Regional Community Platform - Data Plane v1 RLS and Data API grants
-- Assumes data-plane-v1.schema.sql has already been applied.

begin;

alter table public.schema_metadata enable row level security;
alter table public.tenants enable row level security;
alter table public.sites enable row level security;
alter table public.structures enable row level security;
alter table public.units enable row level security;
alter table public.people enable row level security;
alter table public.person_contacts enable row level security;
alter table public.user_identities enable row level security;
alter table public.tenant_roles enable row level security;
alter table public.unit_memberships enable row level security;
alter table public.tenant_policy_versions enable row level security;
alter table public.financial_periods enable row level security;
alter table public.charge_types enable row level security;
alter table public.charges enable row level security;
alter table public.payment_methods enable row level security;
alter table public.payment_reports enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.credit_memos enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.receipts enable row level security;
alter table public.access_integrations enable row level security;
alter table public.access_credentials enable row level security;
alter table public.access_events enable row level security;
alter table public.audit_events enable row level security;

create or replace function public.current_user_has_tenant_role(p_tenant_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.tenant_roles tr
    where tr.tenant_id = p_tenant_id
      and tr.auth_user_id = (select auth.uid())
      and tr.revoked_at is null
      and (p_roles is null or tr.role = any(p_roles))
  );
$$;

create or replace function public.current_user_has_unit(p_tenant_id uuid, p_unit_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.user_identities ui
    join public.unit_memberships um
      on um.tenant_id = ui.tenant_id
     and um.person_id = ui.person_id
    where ui.tenant_id = p_tenant_id
      and ui.auth_user_id = (select auth.uid())
      and ui.status = 'active'
      and um.unit_id = p_unit_id
      and um.effective_from <= current_date
      and (um.effective_to is null or um.effective_to >= current_date)
  );
$$;

create or replace function public.current_user_is_tenant_member(p_tenant_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select public.current_user_has_tenant_role(p_tenant_id, null)
    or exists (
      select 1
      from public.user_identities ui
      join public.unit_memberships um
        on um.tenant_id = ui.tenant_id
       and um.person_id = ui.person_id
      where ui.tenant_id = p_tenant_id
        and ui.auth_user_id = (select auth.uid())
        and ui.status = 'active'
        and um.effective_from <= current_date
        and (um.effective_to is null or um.effective_to >= current_date)
    );
$$;

revoke all on function public.current_user_has_tenant_role(uuid, text[]) from public;
revoke all on function public.current_user_has_unit(uuid, uuid) from public;
revoke all on function public.current_user_is_tenant_member(uuid) from public;
grant execute on function public.current_user_has_tenant_role(uuid, text[]) to authenticated, service_role;
grant execute on function public.current_user_has_unit(uuid, uuid) to authenticated, service_role;
grant execute on function public.current_user_is_tenant_member(uuid) to authenticated, service_role;

create policy schema_metadata_authenticated_read
on public.schema_metadata for select to authenticated
using ((select auth.uid()) is not null);

create policy tenant_roles_self_read
on public.tenant_roles for select to authenticated
using (auth_user_id = (select auth.uid()));

create policy user_identities_self_read
on public.user_identities for select to authenticated
using (auth_user_id = (select auth.uid()) and status = 'active');

create policy unit_memberships_own_or_admin_read
on public.unit_memberships for select to authenticated
using (
  exists (
    select 1 from public.user_identities ui
    where ui.tenant_id = unit_memberships.tenant_id
      and ui.person_id = unit_memberships.person_id
      and ui.auth_user_id = (select auth.uid())
      and ui.status = 'active'
  )
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','board_member','support_admin']::text[]
  )
);

create policy tenants_member_read
on public.tenants for select to authenticated
using (public.current_user_is_tenant_member(id));

create policy sites_member_read
on public.sites for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy structures_member_read
on public.structures for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy units_own_or_admin_read
on public.units for select to authenticated
using (
  public.current_user_has_unit(tenant_id, id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','security_operator','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy people_self_or_admin_read
on public.people for select to authenticated
using (
  exists (
    select 1 from public.user_identities ui
    where ui.tenant_id = people.tenant_id
      and ui.person_id = people.id
      and ui.auth_user_id = (select auth.uid())
      and ui.status = 'active'
  )
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','board_member','support_admin']::text[]
  )
);

create policy person_contacts_self_or_admin_read
on public.person_contacts for select to authenticated
using (
  exists (
    select 1 from public.user_identities ui
    where ui.tenant_id = person_contacts.tenant_id
      and ui.person_id = person_contacts.person_id
      and ui.auth_user_id = (select auth.uid())
      and ui.status = 'active'
  )
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','support_admin']::text[]
  )
);

create policy tenant_policy_member_read
on public.tenant_policy_versions for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy periods_member_read
on public.financial_periods for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy charge_types_member_read
on public.charge_types for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy payment_methods_member_read
on public.payment_methods for select to authenticated
using (public.current_user_is_tenant_member(tenant_id));

create policy charges_unit_or_finance_read
on public.charges for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy payment_reports_unit_or_finance_read
on public.payment_reports for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy payment_reports_resident_insert
on public.payment_reports for insert to authenticated
with check (
  reported_by_auth_user_id = (select auth.uid())
  and public.current_user_has_unit(tenant_id, unit_id)
  and state = 'pending'
  and decided_at is null
  and decided_by is null
);

create policy payments_unit_or_finance_read
on public.payments for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy allocations_unit_or_finance_read
on public.payment_allocations for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy credit_memos_unit_or_finance_read
on public.credit_memos for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy ledger_unit_or_finance_read
on public.ledger_entries for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy receipts_unit_or_finance_read
on public.receipts for select to authenticated
using (
  public.current_user_has_unit(tenant_id, unit_id)
  or public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','accountant','payment_reviewer','board_member','read_only_auditor','support_admin']::text[]
  )
);

create policy access_integrations_security_read
on public.access_integrations for select to authenticated
using (
  public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','security_operator','support_admin']::text[]
  )
);

create policy access_credentials_security_read
on public.access_credentials for select to authenticated
using (
  public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','security_operator','support_admin']::text[]
  )
);

create policy access_events_security_read
on public.access_events for select to authenticated
using (
  public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','security_operator','read_only_auditor','support_admin']::text[]
  )
);

create policy audit_events_authorized_read
on public.audit_events for select to authenticated
using (
  public.current_user_has_tenant_role(
    tenant_id,
    array['tenant_owner','tenant_admin','board_member','read_only_auditor','support_admin']::text[]
  )
);

-- New Supabase projects no longer auto-expose public tables to the Data API.
-- Grants are explicit and RLS remains the row-level authorization boundary.
revoke all on table
  public.schema_metadata,
  public.tenants,
  public.sites,
  public.structures,
  public.units,
  public.people,
  public.person_contacts,
  public.user_identities,
  public.tenant_roles,
  public.unit_memberships,
  public.tenant_policy_versions,
  public.financial_periods,
  public.charge_types,
  public.charges,
  public.payment_methods,
  public.payment_reports,
  public.payments,
  public.payment_allocations,
  public.credit_memos,
  public.ledger_entries,
  public.receipts,
  public.access_integrations,
  public.access_credentials,
  public.access_events,
  public.audit_events
from anon, authenticated;

revoke all on public.unit_currency_balances from anon, authenticated;

grant usage on schema public to authenticated, service_role;

grant select on table
  public.schema_metadata,
  public.tenants,
  public.sites,
  public.structures,
  public.units,
  public.people,
  public.person_contacts,
  public.user_identities,
  public.tenant_roles,
  public.unit_memberships,
  public.tenant_policy_versions,
  public.financial_periods,
  public.charge_types,
  public.charges,
  public.payment_methods,
  public.payment_reports,
  public.payments,
  public.payment_allocations,
  public.credit_memos,
  public.ledger_entries,
  public.receipts,
  public.access_integrations,
  public.access_credentials,
  public.access_events,
  public.audit_events,
  public.unit_currency_balances
to authenticated;

grant insert on table public.payment_reports to authenticated;

grant all privileges on table
  public.schema_metadata,
  public.tenants,
  public.sites,
  public.structures,
  public.units,
  public.people,
  public.person_contacts,
  public.user_identities,
  public.tenant_roles,
  public.unit_memberships,
  public.tenant_policy_versions,
  public.financial_periods,
  public.charge_types,
  public.charges,
  public.payment_methods,
  public.payment_reports,
  public.payments,
  public.payment_allocations,
  public.credit_memos,
  public.ledger_entries,
  public.receipts,
  public.access_integrations,
  public.access_credentials,
  public.access_events,
  public.audit_events
to service_role;

grant select on public.unit_currency_balances to service_role;

commit;
