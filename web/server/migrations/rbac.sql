begin;

create table if not exists rbac_users (
  user_id text primary key,
  username text not null,
  display_name text not null,
  email text,
  org_id text not null default 'local',
  org_name text not null default 'Local',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists rbac_departments (
  id text primary key,
  parent_id text references rbac_departments(id),
  name text not null,
  sort_order integer not null default 0,
  source text not null default 'local',
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists rbac_roles (
  id text primary key,
  name text not null,
  description text not null default '',
  system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists rbac_permissions (
  key text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'system'
);

create table if not exists rbac_role_permissions (
  role_id text not null references rbac_roles(id) on delete cascade,
  permission_key text not null references rbac_permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists rbac_user_roles (
  user_id text not null references rbac_users(user_id) on delete cascade,
  role_id text not null references rbac_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table if not exists rbac_user_departments (
  user_id text not null references rbac_users(user_id) on delete cascade,
  department_id text not null references rbac_departments(id) on delete cascade,
  primary_department boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, department_id)
);

create table if not exists rbac_department_roles (
  department_id text not null references rbac_departments(id) on delete cascade,
  role_id text not null references rbac_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (department_id, role_id)
);

create table if not exists rbac_audit_log (
  id text primary key,
  actor_user_id text not null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists app_system_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_rbac_departments_parent on rbac_departments(parent_id) where deleted_at is null;
create index if not exists idx_rbac_departments_source_external on rbac_departments(source, external_id) where external_id is not null and deleted_at is null;
create index if not exists idx_rbac_users_last_seen on rbac_users(last_seen_at desc, display_name);
create index if not exists idx_rbac_users_search on rbac_users(lower(display_name), lower(username), lower(coalesce(email, '')));
create unique index if not exists idx_rbac_roles_name_active on rbac_roles(lower(name)) where deleted_at is null;
create index if not exists idx_rbac_user_roles_role on rbac_user_roles(role_id);
create index if not exists idx_rbac_user_departments_department on rbac_user_departments(department_id);
create index if not exists idx_rbac_department_roles_role on rbac_department_roles(role_id);
create index if not exists idx_rbac_audit_created_at on rbac_audit_log(created_at desc);

insert into rbac_permissions (key, name, description, category)
values ('admin:access', '进入管理后台', '允许进入管理后台并进行管理操作', 'system')
on conflict (key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category;

insert into rbac_departments (id, parent_id, name, sort_order, source)
values ('dept-root', null, '默认组织', 0, 'system')
on conflict (id) do update set
  name = excluded.name,
  updated_at = now(),
  deleted_at = null;

insert into rbac_roles (id, name, description, system)
values ('role-system-admin', '系统管理员', '拥有系统管理后台访问权限', true)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  system = true,
  updated_at = now(),
  deleted_at = null;

insert into rbac_role_permissions (role_id, permission_key)
values ('role-system-admin', 'admin:access')
on conflict do nothing;

insert into app_system_settings (key, value)
values ('registration.enabled', 'true'::jsonb)
on conflict (key) do nothing;

update rbac_audit_log
set metadata = metadata - 'primaryDepartmentId'
where metadata ? 'primaryDepartmentId';

commit;
