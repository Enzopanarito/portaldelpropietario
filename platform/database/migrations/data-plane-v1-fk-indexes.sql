-- Data Plane v1 performance indexes identified by Supabase advisors.
begin;

create index if not exists access_credentials_tenant_person_idx on public.access_credentials(tenant_id, person_id);
create index if not exists access_credentials_tenant_unit_idx on public.access_credentials(tenant_id, unit_id);
create index if not exists access_events_tenant_credential_idx on public.access_events(tenant_id, credential_id);
create index if not exists access_events_tenant_unit_idx on public.access_events(tenant_id, unit_id);
create index if not exists audit_events_actor_idx on public.audit_events(actor_auth_user_id);
create index if not exists charges_created_by_idx on public.charges(created_by);
create index if not exists charges_tenant_charge_type_idx on public.charges(tenant_id, charge_type_id);
create index if not exists charges_tenant_period_idx on public.charges(tenant_id, period_id);
create index if not exists credit_memos_created_by_idx on public.credit_memos(created_by);
create index if not exists ledger_entries_created_by_idx on public.ledger_entries(created_by);
create index if not exists ledger_entries_tenant_period_idx on public.ledger_entries(tenant_id, period_id);
create index if not exists ledger_entries_tenant_reversal_idx on public.ledger_entries(tenant_id, reversal_of);
create index if not exists payment_allocations_tenant_unit_charge_idx on public.payment_allocations(tenant_id, unit_id, charge_id);
create index if not exists payment_allocations_tenant_unit_payment_idx on public.payment_allocations(tenant_id, unit_id, payment_id);
create index if not exists payment_reports_decided_by_idx on public.payment_reports(decided_by);
create index if not exists payment_reports_reported_by_idx on public.payment_reports(reported_by_auth_user_id);
create index if not exists payment_reports_tenant_method_idx on public.payment_reports(tenant_id, payment_method_id);
create index if not exists payments_created_by_idx on public.payments(created_by);
create index if not exists payments_tenant_method_idx on public.payments(tenant_id, payment_method_id);
create index if not exists payments_tenant_unit_report_idx on public.payments(tenant_id, unit_id, payment_report_id);
create index if not exists receipts_tenant_unit_payment_idx on public.receipts(tenant_id, unit_id, payment_id);
create index if not exists structures_tenant_parent_idx on public.structures(tenant_id, parent_structure_id);
create index if not exists tenant_policy_versions_created_by_idx on public.tenant_policy_versions(created_by);
create index if not exists units_tenant_structure_idx on public.units(tenant_id, structure_id);

commit;
