begin;
create index if not exists tenant_pool_country_mode_fk_idx
on platform_control.tenant_pool_bindings(pool_id, country_code, pool_mode);
create index if not exists tenant_pool_tenant_country_fk_idx
on platform_control.tenant_pool_bindings(tenant_id, country_code);
commit;
