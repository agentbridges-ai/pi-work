begin;

-- The index is deliberately non-authoritative. session.json and Pi JSONL stay
-- the only authority for product/runtime state; this table is a rebuildable
-- control-plane projection for diagnostics and restart reconciliation.
create table if not exists runtime_session_index (
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null,
  membership_id text not null references tenant_memberships(id) on delete cascade,
  org_node_id text not null references org_nodes(id) on delete cascade,
  session_id text not null,
  generation bigint not null default 0 check (generation >= 0),
  lifecycle text not null default 'stopped'
    check (lifecycle in ('preparing', 'starting', 'connecting', 'ready', 'running', 'stopping', 'stopped', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  primary key (tenant_id, session_id),
  unique (tenant_id, membership_id, org_node_id, session_id)
);
create index if not exists idx_runtime_session_index_owner
  on runtime_session_index(tenant_id, user_id, updated_at desc, session_id);
create index if not exists idx_runtime_session_index_lifecycle
  on runtime_session_index(tenant_id, lifecycle, updated_at desc);

-- Existing memberships created before org-node authority was pinned receive
-- the tenant root as their primary scope. This is idempotent and does not
-- create a second filesystem tenant.
insert into membership_org_nodes (membership_id, org_node_id, primary_org)
select m.id, root.id, true
from tenant_memberships m
join org_nodes root on root.tenant_id=m.tenant_id and root.is_root and root.deleted_at is null
where not exists (
  select 1 from membership_org_nodes existing
  where existing.membership_id=m.id
)
on conflict do nothing;

create or replace function piwork_current_tenant_id()
returns text
language sql
stable
as $$ select nullif(current_setting('piwork.tenant_id', true), '') $$;

create or replace function piwork_current_user_id()
returns text
language sql
stable
as $$ select nullif(current_setting('piwork.user_id', true), '') $$;

create or replace function piwork_current_membership_id()
returns text
language sql
stable
as $$ select nullif(current_setting('piwork.membership_id', true), '') $$;

create or replace function piwork_current_org_node_id()
returns text
language sql
stable
as $$ select nullif(current_setting('piwork.org_node_id', true), '') $$;

-- Every product table carrying tenant_id is protected. Better Auth's global
-- user/account/session tables intentionally do not have tenant_id and are not
-- included. The application role must be a non-owner, non-BYPASSRLS role and
-- set these transaction-local settings before touching tenant data.
do $$
declare
  item record;
  has_user_id boolean;
  using_policy text;
  check_policy text;
  user_scope text;
  global_scope text;
begin
  for item in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema=c.table_schema and t.table_name=c.table_name
    where c.table_schema='public'
      and c.column_name='tenant_id'
      and t.table_type='BASE TABLE'
  loop
    select exists (
      select 1 from information_schema.columns
      where table_schema=item.table_schema and table_name=item.table_name and column_name='user_id'
    ) into has_user_id;
    user_scope := case
      when not has_user_id then 'false'
      when item.table_name = 'tenant_memberships' then
        'user_id = piwork_current_user_id()'
      else
        format(
          'user_id = piwork_current_user_id()
           and exists (
             select 1 from tenant_memberships m
             where m.user_id = piwork_current_user_id()
               and m.tenant_id = %I.%I.tenant_id
               and m.status = ''active''
           )',
          item.table_schema,
          item.table_name
        )
    end;
    global_scope := case
      when has_user_id then 'user_id = piwork_current_user_id()'
      else 'piwork_current_tenant_id() is not null'
    end;
    using_policy := format(
      '(tenant_id = piwork_current_tenant_id())
       or (tenant_id is null and (%s))
       or (%s)',
      global_scope,
      format(
        'piwork_current_tenant_id() is null
         and piwork_current_user_id() is not null
         and tenant_id is not null
         and (%s)',
        user_scope
      )
    );
    check_policy := format(
      '(tenant_id = piwork_current_tenant_id())
       or (tenant_id is null and (%s))
       or (%s)',
      global_scope,
      format(
        'piwork_current_tenant_id() is null
         and piwork_current_user_id() is not null
         and tenant_id is not null
         and (%s)',
        user_scope
      )
    );
    execute format('alter table %I.%I enable row level security', item.table_schema, item.table_name);
    execute format('alter table %I.%I force row level security', item.table_schema, item.table_name);
    execute format('drop policy if exists piwork_tenant_scope on %I.%I', item.table_schema, item.table_name);
    execute format(
      'create policy piwork_tenant_scope on %I.%I using (%s) with check (%s)',
      item.table_schema,
      item.table_name,
      using_policy,
      check_policy
    );
  end loop;
end
$$;

-- Tables without a tenant_id still carry tenant-owned control-plane data.
-- They receive explicit policies so bootstrap membership discovery can see only
-- the current user's memberships and their organization roots.
alter table tenants enable row level security;
alter table tenants force row level security;
drop policy if exists piwork_tenant_scope on tenants;
create policy piwork_tenant_scope on tenants
  using (
    id = piwork_current_tenant_id()
    or exists (
      select 1 from tenant_memberships m
      where m.tenant_id=tenants.id and m.user_id=piwork_current_user_id()
    )
  )
  with check (
    id = piwork_current_tenant_id()
  );

alter table membership_org_nodes enable row level security;
alter table membership_org_nodes force row level security;
drop policy if exists piwork_tenant_scope on membership_org_nodes;
create policy piwork_tenant_scope on membership_org_nodes
  using (
    exists (
      select 1 from tenant_memberships m
      where m.id=membership_org_nodes.membership_id
        and m.user_id=piwork_current_user_id()
        and (piwork_current_tenant_id() is null or m.tenant_id=piwork_current_tenant_id())
    )
  )
  with check (
    exists (
      select 1 from tenant_memberships m
      where m.id=membership_org_nodes.membership_id
        and m.user_id=piwork_current_user_id()
        and (piwork_current_tenant_id() is null or m.tenant_id=piwork_current_tenant_id())
    )
  );

drop policy if exists piwork_tenant_scope on org_nodes;
alter table org_nodes enable row level security;
alter table org_nodes force row level security;
create policy piwork_tenant_scope on org_nodes
  using (
    tenant_id=piwork_current_tenant_id()
    or exists (
      select 1
      from membership_org_nodes mo
      join tenant_memberships m on m.id=mo.membership_id
      where mo.org_node_id=org_nodes.id and m.user_id=piwork_current_user_id()
    )
  )
  with check (
    tenant_id=piwork_current_tenant_id()
  );

commit;
