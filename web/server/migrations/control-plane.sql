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

create table if not exists apps (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  owner_membership_id text not null references tenant_memberships(id) on delete restrict,
  owner_user_id text not null,
  source_session_id text,
  source_session_generation bigint not null default 0 check (source_session_generation >= 0),
  source_snapshot_key text,
  tenant_handle text not null,
  worker_name text not null unique,
  slug text not null,
  name text not null,
  status text not null default 'building'
    check (status in ('building', 'needs_action', 'deploying', 'preview', 'ready', 'failed', 'archived')),
  status_reason text,
  stable_url text,
  screenshot_url text,
  current_deployment_id text,
  generation bigint not null default 0 check (generation >= 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id, slug),
  check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
);
alter table apps add column if not exists tenant_handle text;
alter table apps add column if not exists worker_name text;
update apps set tenant_handle='tenant-' || substr(md5(tenant_id),1,8) where tenant_handle is null;
update apps set worker_name='piwork-app-' || lower(regexp_replace(id,'[^A-Za-z0-9-]','-','g'))
  where worker_name is null;
alter table apps alter column tenant_handle set not null;
alter table apps alter column worker_name set not null;
alter table apps add column if not exists archived_at timestamptz;
create unique index if not exists idx_apps_worker_name on apps(worker_name);
alter table apps drop constraint if exists apps_status_check;
alter table apps add constraint apps_status_check check (
  status in ('building', 'needs_action', 'deploying', 'preview', 'ready', 'failed', 'archived')
);
create index if not exists idx_apps_tenant_updated
  on apps(tenant_id, updated_at desc, id desc);
create index if not exists idx_apps_owner_updated
  on apps(tenant_id, owner_user_id, updated_at desc, id desc);
create index if not exists idx_apps_source_session
  on apps(tenant_id, source_session_id, updated_at desc) where source_session_id is not null;
create index if not exists idx_apps_archived
  on apps(tenant_id, archived_at desc) where status = 'archived';

create table if not exists app_deployments (
  id text primary key,
  app_id text not null references apps(id) on delete cascade,
  version integer not null check (version > 0),
  phase text not null default 'building' check (
    phase in ('building', 'awaiting_target', 'awaiting_oauth', 'queued', 'provisioning',
      'deploying', 'temporary_ready', 'claim_pending', 'verifying_claim', 'ready',
      'expired', 'failed', 'cancelled')
  ),
  source_session_id text not null,
  source_session_generation bigint not null check (source_session_generation >= 0),
  source_digest text not null,
  source_snapshot_key text,
  artifact_key text,
  manifest jsonb not null,
  binding_manifest jsonb not null default '{}'::jsonb,
  cloudflare_version_id text,
  cloudflare_migration_tag text,
  stable_url text,
  screenshot_url text,
  warnings jsonb not null default '[]'::jsonb,
  error_code text,
  error_message text,
  rollback_of_deployment_id text references app_deployments(id) on delete set null,
  idempotency_key text not null,
  app_generation bigint not null check (app_generation > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  deployed_at timestamptz,
  unique (app_id, version),
  unique (app_id, idempotency_key)
);
create index if not exists idx_app_deployments_app_created
  on app_deployments(app_id, version desc);
create index if not exists idx_app_deployments_retention
  on app_deployments(app_id, deployed_at desc) where phase = 'ready';

alter table apps drop constraint if exists apps_current_deployment_id_fkey;
alter table apps add constraint apps_current_deployment_id_fkey
  foreign key (current_deployment_id) references app_deployments(id) on delete restrict;

create table if not exists app_custom_domains (
  id text primary key,
  app_id text not null unique references apps(id) on delete cascade,
  hostname text not null,
  cloudflare_connection_id text not null,
  zone_id text not null,
  cloudflare_hostname_id text,
  certificate_id text,
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'removing')),
  ssl_status text not null default 'pending_validation'
    check (ssl_status in ('pending_validation', 'pending_issuance', 'active', 'failed')),
  validation_records jsonb not null default '[]'::jsonb,
  error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz
);
create unique index if not exists idx_app_custom_domains_hostname
  on app_custom_domains(lower(hostname));

create table if not exists app_operation_outbox (
  id text primary key,
  app_id text not null references apps(id) on delete cascade,
  tenant_id text not null references tenants(id) on delete cascade,
  operation text not null
    check (operation in ('deploy', 'rollback', 'domain_set', 'claim_verify')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'pending' check (state in ('pending', 'leased', 'completed', 'failed')),
  app_generation bigint not null check (app_generation > 0),
  idempotency_key text not null,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (app_id, operation, idempotency_key)
);
create index if not exists idx_app_operation_outbox_claim
  on app_operation_outbox(state, available_at, created_at);

create table if not exists app_leases (
  app_id text primary key references apps(id) on delete cascade,
  lease_token text not null unique,
  holder text not null,
  app_generation bigint not null check (app_generation >= 0),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_app_leases_expires on app_leases(expires_at);

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

-- Cloudflare account authority for Apps. OAuth and temporary-account bearer
-- credentials are AES-GCM envelopes; no plaintext token or claim URL belongs
-- in Postgres, session files, logs, or browser responses.
create table if not exists cloudflare_connections (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  scope text not null check (scope in ('user', 'tenant')),
  owner_user_id text,
  owner_membership_id text references tenant_memberships(id) on delete cascade,
  account_id text not null,
  account_name text not null,
  granted_scopes jsonb not null default '[]'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'refresh_required', 'error', 'revoked')),
  credential_ciphertext text,
  credential_iv text,
  credential_auth_tag text,
  credential_key_version integer,
  access_expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error_code text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (
    (scope='user' and owner_user_id is not null and owner_membership_id is not null)
    or (scope='tenant' and owner_user_id is null and owner_membership_id is null)
  ),
  check (
    (status='revoked' and credential_ciphertext is null and credential_iv is null
      and credential_auth_tag is null and credential_key_version is null)
    or status <> 'revoked'
  )
);
create unique index if not exists idx_cloudflare_connections_user_account
  on cloudflare_connections(tenant_id, owner_user_id, account_id) where scope='user';
create unique index if not exists idx_cloudflare_connections_tenant_account
  on cloudflare_connections(tenant_id, account_id) where scope='tenant';
create index if not exists idx_cloudflare_connections_visible
  on cloudflare_connections(tenant_id, owner_user_id, updated_at desc);

alter table app_custom_domains add column if not exists cloudflare_connection_id text;
alter table app_custom_domains add column if not exists zone_id text;
alter table app_custom_domains add column if not exists certificate_id text;
alter table app_custom_domains drop constraint if exists app_custom_domains_cloudflare_connection_id_fkey;
alter table app_custom_domains add constraint app_custom_domains_cloudflare_connection_id_fkey
  foreign key (cloudflare_connection_id) references cloudflare_connections(id) on delete restrict;

create table if not exists cloudflare_temporary_previews (
  id text primary key,
  app_id text not null references apps(id) on delete cascade,
  tenant_id text not null references tenants(id) on delete cascade,
  owner_user_id text not null,
  owner_membership_id text not null references tenant_memberships(id) on delete cascade,
  account_id text,
  account_name text,
  status text not null default 'provisioning'
    check (status in ('provisioning', 'ready', 'claiming', 'claimed', 'expired', 'failed')),
  credential_ciphertext text,
  credential_iv text,
  credential_auth_tag text,
  credential_key_version integer,
  claim_ciphertext text,
  claim_iv text,
  claim_auth_tag text,
  claim_key_version integer,
  account_expires_at timestamptz,
  claim_expires_at timestamptz,
  expires_at timestamptz,
  terms_of_service_url text not null,
  privacy_policy_url text not null,
  policies_accepted_at timestamptz not null,
  claimed_connection_id text references cloudflare_connections(id) on delete set null,
  last_error_code text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at <= policies_accepted_at + interval '60 minutes'),
  check (
    status not in ('claimed', 'expired', 'failed')
    or (credential_ciphertext is null and credential_iv is null
      and credential_auth_tag is null and credential_key_version is null
      and claim_ciphertext is null and claim_iv is null
      and claim_auth_tag is null and claim_key_version is null)
  )
);
create unique index if not exists idx_cloudflare_temporary_previews_account
  on cloudflare_temporary_previews(account_id) where account_id is not null;
create unique index if not exists idx_cloudflare_temporary_previews_active_app
  on cloudflare_temporary_previews(app_id) where status in ('provisioning', 'ready', 'claiming');
create index if not exists idx_cloudflare_temporary_previews_owner
  on cloudflare_temporary_previews(tenant_id, owner_user_id, created_at desc);
create index if not exists idx_cloudflare_temporary_previews_expiry
  on cloudflare_temporary_previews(expires_at)
  where status in ('ready', 'claiming');

create table if not exists cloudflare_oauth_states (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null,
  membership_id text not null references tenant_memberships(id) on delete cascade,
  connection_scope text not null check (connection_scope in ('user', 'tenant')),
  purpose text not null check (purpose in ('direct', 'claim')),
  app_id text not null references apps(id) on delete cascade,
  deployment_id text not null references app_deployments(id) on delete cascade,
  app_generation bigint not null check (app_generation > 0),
  temporary_account_id text references cloudflare_temporary_previews(id) on delete set null,
  state_hash text not null unique,
  verifier_ciphertext text,
  verifier_iv text,
  verifier_auth_tag text,
  verifier_key_version integer,
  requested_scopes jsonb not null default '[]'::jsonb,
  requested_scope_names jsonb not null default '[]'::jsonb,
  redirect_uri text not null,
  return_path text not null default '/apps',
  status text not null default 'pending'
    check (status in ('pending', 'exchanging', 'completed', 'failed', 'expired')),
  connection_id text references cloudflare_connections(id) on delete set null,
  last_error_code text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '10 minutes'),
  check (
    status='pending'
    or (verifier_ciphertext is null and verifier_iv is null
      and verifier_auth_tag is null and verifier_key_version is null)
  )
);
alter table cloudflare_oauth_states add column if not exists purpose text;
update cloudflare_oauth_states
set purpose=case when temporary_account_id is null then 'direct' else 'claim' end
where purpose is null;
alter table cloudflare_oauth_states alter column purpose set not null;
alter table cloudflare_oauth_states drop constraint if exists cloudflare_oauth_states_purpose_check;
alter table cloudflare_oauth_states add constraint cloudflare_oauth_states_purpose_check
  check (purpose in ('direct', 'claim'));
create index if not exists idx_cloudflare_oauth_states_expiry
  on cloudflare_oauth_states(expires_at) where status='pending';
create index if not exists idx_cloudflare_oauth_states_owner
  on cloudflare_oauth_states(tenant_id, user_id, created_at desc);

alter table apps add column if not exists target_kind text not null default 'unassigned';
alter table apps add column if not exists cloudflare_connection_id text;
alter table apps add column if not exists temporary_preview_id text;
alter table apps drop constraint if exists apps_target_kind_check;
alter table apps add constraint apps_target_kind_check check (
  (target_kind='unassigned' and cloudflare_connection_id is null and temporary_preview_id is null)
  or (target_kind='temporary' and cloudflare_connection_id is null and temporary_preview_id is not null)
  or (target_kind='byoc' and cloudflare_connection_id is not null and temporary_preview_id is null)
);
alter table apps drop constraint if exists apps_cloudflare_connection_id_fkey;
alter table apps add constraint apps_cloudflare_connection_id_fkey
  foreign key (cloudflare_connection_id) references cloudflare_connections(id) on delete restrict;
alter table apps drop constraint if exists apps_temporary_preview_id_fkey;
alter table apps add constraint apps_temporary_preview_id_fkey
  foreign key (temporary_preview_id) references cloudflare_temporary_previews(id) on delete restrict;
create index if not exists idx_apps_cloudflare_target
  on apps(tenant_id, target_kind, cloudflare_connection_id, temporary_preview_id);

alter table app_deployments add column if not exists target_kind text not null default 'unassigned';
alter table app_deployments add column if not exists phase text not null default 'awaiting_target';
alter table app_deployments add column if not exists cloudflare_migration_tag text;
alter table app_deployments add column if not exists cloudflare_connection_id text;
alter table app_deployments add column if not exists temporary_preview_id text;
alter table app_deployments drop constraint if exists app_deployments_target_kind_check;
alter table app_deployments add constraint app_deployments_target_kind_check check (
  target_kind in ('unassigned', 'temporary', 'byoc')
);
alter table app_deployments drop constraint if exists app_deployments_phase_check;
alter table app_deployments add constraint app_deployments_phase_check check (
  phase in ('building', 'awaiting_target', 'awaiting_oauth', 'queued', 'provisioning',
    'deploying', 'temporary_ready', 'claim_pending', 'verifying_claim', 'ready',
    'expired', 'failed', 'cancelled')
);
alter table app_deployments drop constraint if exists app_deployments_cloudflare_connection_id_fkey;
alter table app_deployments add constraint app_deployments_cloudflare_connection_id_fkey
  foreign key (cloudflare_connection_id) references cloudflare_connections(id) on delete restrict;
alter table app_deployments drop constraint if exists app_deployments_temporary_preview_id_fkey;
alter table app_deployments add constraint app_deployments_temporary_preview_id_fkey
  foreign key (temporary_preview_id) references cloudflare_temporary_previews(id) on delete restrict;

create table if not exists app_resource_receipts (
  id text primary key,
  app_id text not null references apps(id) on delete cascade,
  deployment_id text not null references app_deployments(id) on delete cascade,
  target_kind text not null check (target_kind in ('temporary', 'byoc')),
  cloudflare_connection_id text references cloudflare_connections(id) on delete restrict,
  temporary_preview_id text references cloudflare_temporary_previews(id) on delete restrict,
  logical_key text not null,
  resource_kind text not null
    check (resource_kind in ('worker', 'assets', 'kv', 'r2', 'd1', 'durable_object', 'domain')),
  mode text not null check (mode in ('create', 'adopt')),
  external_id text,
  external_name text,
  ownership text not null check (ownership in ('created', 'adopted')),
  step_status text not null default 'planned'
    check (step_status in ('planned', 'provisioning', 'ready', 'failed', 'needs_cleanup')),
  metadata jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((mode='create' and ownership='created') or (mode='adopt' and ownership='adopted')),
  check (
    (target_kind='temporary' and cloudflare_connection_id is null
      and temporary_preview_id is not null and resource_kind in ('worker', 'assets'))
    or (target_kind='byoc' and cloudflare_connection_id is not null
      and temporary_preview_id is null)
  ),
  unique (deployment_id, resource_kind, logical_key)
);
create index if not exists idx_app_resource_receipts_app
  on app_resource_receipts(app_id, deployment_id, created_at desc);

insert into control_permissions (key, name, category) values
  ('tenant:manage', '管理租户', 'tenant'), ('member:manage', '管理成员', 'tenant'),
  ('org:manage', '管理组织', 'rbac'), ('role:manage', '管理角色', 'rbac'),
  ('agent:create', '创建 Agent', 'agent'), ('agent:edit', '编辑 Agent', 'agent'),
  ('agent:publish', '发布 Agent', 'agent'), ('agent:grant', '授权 Agent', 'agent'),
  ('agent:use', '使用 Agent', 'agent'), ('knowledge:manage', '管理知识目录', 'resource'),
  ('skill:manage', '管理 Skills', 'resource'), ('mcp:manage', '管理 MCP', 'resource'),
  ('network-policy:manage', '管理网络策略', 'resource'), ('runtime:view', '查看 Runtime', 'runtime'),
  ('runtime:manage', '管理 Runtime', 'runtime'), ('session:view', '查看会话', 'session'),
  ('session:terminate', '终止会话', 'session'), ('audit:view', '查看审计', 'audit'),
  ('app:publish', '发布 App', 'app'), ('app:manage-own', '管理自己的 App', 'app'),
  ('app:manage-all', '管理全部 App', 'app')
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
insert into scoped_role_permissions (role_id, permission_key) values
  ('role-template-member', 'agent:use'),
  ('role-template-member', 'app:publish'),
  ('role-template-member', 'app:manage-own')
on conflict do nothing;

commit;
