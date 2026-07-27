begin;

create table if not exists tenants (
  id text primary key,
  type text not null check (type in ('enterprise', 'team', 'personal')),
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tenant_memberships (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended', 'removed')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create unique index if not exists idx_tenant_memberships_default
  on tenant_memberships(user_id) where is_default and status = 'active';
create index if not exists idx_tenant_memberships_user on tenant_memberships(user_id, status);

create table if not exists user_tenant_context (
  user_id text primary key,
  tenant_id text not null references tenants(id),
  updated_at timestamptz not null default now()
);

create table if not exists user_onboarding (
  user_id text primary key,
  registration_type text not null check (registration_type in ('personal', 'team', 'enterprise')),
  tenant_id text not null references tenants(id),
  completed_at timestamptz not null default now()
);

create table if not exists org_nodes (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  parent_id text,
  name text not null,
  sort_order integer not null default 0,
  is_root boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references org_nodes(tenant_id, id)
);

create unique index if not exists idx_org_nodes_single_root
  on org_nodes(tenant_id) where is_root and deleted_at is null;
create index if not exists idx_org_nodes_parent on org_nodes(tenant_id, parent_id) where deleted_at is null;

create table if not exists org_node_closure (
  tenant_id text not null references tenants(id) on delete cascade,
  ancestor_id text not null,
  descendant_id text not null,
  depth integer not null check (depth >= 0),
  primary key (tenant_id, ancestor_id, descendant_id),
  foreign key (tenant_id, ancestor_id) references org_nodes(tenant_id, id) on delete cascade,
  foreign key (tenant_id, descendant_id) references org_nodes(tenant_id, id) on delete cascade
);

create table if not exists membership_org_nodes (
  membership_id text not null references tenant_memberships(id) on delete cascade,
  org_node_id text not null references org_nodes(id) on delete cascade,
  primary_org boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (membership_id, org_node_id)
);
create unique index if not exists idx_membership_primary_org
  on membership_org_nodes(membership_id) where primary_org;

create table if not exists scoped_roles (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  name text not null,
  description text not null default '',
  scope_kind text not null check (scope_kind in ('platform', 'tenant', 'org_subtree')),
  system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists control_permissions (
  key text primary key,
  name text not null,
  category text not null
);

create table if not exists scoped_role_permissions (
  role_id text not null references scoped_roles(id) on delete cascade,
  permission_key text not null references control_permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists scoped_role_assignments (
  id text primary key,
  role_id text not null references scoped_roles(id) on delete cascade,
  user_id text not null,
  tenant_id text references tenants(id) on delete cascade,
  org_node_id text references org_nodes(id) on delete cascade,
  created_by text not null,
  created_at timestamptz not null default now(),
  check ((tenant_id is null and org_node_id is null) or tenant_id is not null)
);
create index if not exists idx_scoped_assignments_user on scoped_role_assignments(user_id, tenant_id);

create table if not exists knowledge_roots (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  relative_path text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, relative_path),
  check (relative_path <> '' and relative_path !~ '(^/|(^|/)\.\.(/|$))')
);

create table if not exists network_policies (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  allowed_domains jsonb not null default '[]'::jsonb,
  denied_domains jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (id, version)
);

create table if not exists encrypted_secrets (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  owner_membership_id text references tenant_memberships(id) on delete cascade,
  purpose text not null,
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  key_version integer not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists mcp_connections (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  owner_membership_id text references tenant_memberships(id) on delete cascade,
  name text not null,
  transport text not null check (transport in ('stdio', 'sse', 'streamable-http')),
  config jsonb not null default '{}'::jsonb,
  secret_id text references encrypted_secrets(id),
  version integer not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, version)
);
alter table mcp_connections drop constraint if exists mcp_connections_transport_check;
update mcp_connections set transport='streamable-http' where transport='http';
alter table mcp_connections add constraint mcp_connections_transport_check
  check (transport in ('stdio', 'sse', 'streamable-http'));

create table if not exists skill_packages (
  id text primary key,
  tenant_id text references tenants(id) on delete cascade,
  owner_membership_id text references tenant_memberships(id) on delete cascade,
  source_url text not null,
  source_commit text not null,
  digest text not null,
  scan_status text not null check (scan_status in ('pending', 'passed', 'failed')),
  approval_status text not null check (approval_status in ('pending', 'approved', 'rejected')),
  approved_by text,
  content_snapshot jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (source_url, source_commit, digest)
);

create table if not exists agent_definitions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  owner_membership_id text references tenant_memberships(id) on delete cascade,
  kind text not null check (kind in ('enterprise_shared', 'team_shared', 'personal_custom', 'general')),
  name text not null,
  description text not null default '',
  immutable boolean not null default false,
  current_version_id text,
  draft jsonb not null default '{"knowledgeRootIds":[],"skillPackageIds":[],"mcpConnectionIds":[],"modelAllowlist":["*/*"],"defaultThinkingLevel":"medium"}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table agent_definitions alter column draft set default
  '{"knowledgeRootIds":[],"skillPackageIds":[],"mcpConnectionIds":[],"modelAllowlist":["*/*"],"defaultThinkingLevel":"medium"}'::jsonb;

create table if not exists agent_versions (
  id text primary key,
  agent_definition_id text not null references agent_definitions(id) on delete cascade,
  version integer not null,
  config jsonb not null,
  effective_policy_hash text not null,
  published_by text not null,
  published_at timestamptz not null default now(),
  unique (agent_definition_id, version)
);
alter table agent_definitions drop constraint if exists agent_definitions_current_version_id_fkey;
alter table agent_definitions add constraint agent_definitions_current_version_id_fkey
  foreign key (current_version_id) references agent_versions(id);

create table if not exists agent_grants (
  id text primary key,
  agent_definition_id text not null references agent_definitions(id) on delete cascade,
  grantee_kind text not null check (grantee_kind in ('tenant', 'org_subtree', 'role', 'membership')),
  grantee_id text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (agent_definition_id, grantee_kind, grantee_id)
);

create table if not exists entitlements (
  tenant_id text not null references tenants(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create table if not exists control_plane_audit_log (
  id text primary key,
  tenant_id text references tenants(id) on delete set null,
  actor_user_id text not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_control_audit_tenant_created
  on control_plane_audit_log(tenant_id, created_at desc);

insert into control_permissions (key, name, category) values
  ('tenant:manage', '管理租户', 'tenant'), ('member:manage', '管理成员', 'tenant'),
  ('org:manage', '管理组织', 'rbac'), ('role:manage', '管理角色', 'rbac'),
  ('agent:create', '创建 Agent', 'agent'), ('agent:edit', '编辑 Agent', 'agent'),
  ('agent:publish', '发布 Agent', 'agent'), ('agent:grant', '授权 Agent', 'agent'),
  ('agent:use', '使用 Agent', 'agent'), ('knowledge:manage', '管理知识目录', 'resource'),
  ('skill:manage', '管理 Skills', 'resource'), ('mcp:manage', '管理 MCP', 'resource'),
  ('network-policy:manage', '管理网络策略', 'resource'), ('runtime:view', '查看 Runtime', 'runtime'),
  ('runtime:manage', '管理 Runtime', 'runtime'), ('session:view', '查看会话', 'session'),
  ('session:terminate', '终止会话', 'session'), ('audit:view', '查看审计', 'audit')
on conflict (key) do update set name = excluded.name, category = excluded.category;

insert into scoped_roles (id, tenant_id, name, description, scope_kind, system) values
  ('role-platform-system-admin', null, '系统管理员', '跨租户平台最高权限', 'platform', true),
  ('role-template-tenant-admin', null, '组织管理员', '管理单个租户', 'tenant', true),
  ('role-template-org-admin', null, '部门管理员', '管理指定组织子树', 'org_subtree', true),
  ('role-template-member', null, '成员', '使用获授权 Agent', 'tenant', true)
on conflict (id) do update set name = excluded.name, description = excluded.description, system = true;

insert into scoped_role_permissions (role_id, permission_key)
select 'role-platform-system-admin', key from control_permissions
on conflict do nothing;
insert into scoped_role_permissions (role_id, permission_key)
select 'role-template-tenant-admin', key from control_permissions where key <> 'tenant:manage'
on conflict do nothing;
insert into scoped_role_permissions (role_id, permission_key)
select 'role-template-org-admin', key from control_permissions
where key in ('member:manage','org:manage','agent:create','agent:edit','agent:publish','agent:grant','agent:use','knowledge:manage','session:view','session:terminate','audit:view')
on conflict do nothing;
insert into scoped_role_permissions (role_id, permission_key) values ('role-template-member', 'agent:use')
on conflict do nothing;

commit;
