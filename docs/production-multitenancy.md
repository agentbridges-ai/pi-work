# Production multi-tenancy

Piwork keeps Better Auth as the account authority and resolves an active
tenant membership after authentication. A browser cookie is never forwarded to
a tenant runtime. Governed launches pin the Agent policy and native Pi 0.82.1.

## Bootstrap

```bash
make migrate
```

Required production secrets:

- `PIWORK_MCP_MASTER_KEY`: a base64-encoded 32-byte AES key. Rotate by adding a new key version and re-encrypting stored secret envelopes before retiring the previous deployment key.
- `PIWORK_SESSION_SANDBOX=srt`: mandatory in production. Production launches
  require Linux and fail closed when SRT is disabled, missing, or cannot provide
  verifiable descendant-process containment.

The initial user retaining legacy `admin:access` is synchronized to the platform system-administrator role during the compatibility period. Use that account to create enterprise or team tenants. Each account also receives a personal tenant and one immutable-definition general Agent.

## Runtime filesystem

```text
data/tenants/<tenantId>/
  users/<userId>/profile/
  users/<userId>/sessions/<sessionId>/
  users/<userId>/pi-resources/skills/
  knowledge/<registered-relative-path>/
```

Each session directory contains exactly `workspace`, `home`, `tmp`,
`pi-config`, `pi-sessions`, `recordings`, `user-space-checkouts`, and
`session.json`. Pi JSONL is the only conversation/model/compaction/Plan/Todo
authority. `session.json` stores product authority and a relative JSONL path,
not a duplicate history.

Run the legacy migration without `--execute` first. It always writes a manifest and is idempotent because existing targets are skipped:

```bash
cd web
bun scripts/migrate-local-data-to-tenants.ts
bun scripts/migrate-local-data-to-tenants.ts --execute
```

Knowledge roots are registered as paths relative to a tenant's `knowledge/` directory. Absolute paths, `..`, symlinks escaping the tenant root, and cross-tenant references are rejected.

Before any native Pi session starts, the data root must contain the valid Pi v1
`.runtime/runtime-layout.json` marker. A new empty root is initialized. A
non-empty unmarked root fails closed. Review and then explicitly apply the
incompatible reset:

```bash
make pi-reset-legacy-sessions
CONFIRM_PI_SESSION_RESET=1 make pi-reset-legacy-sessions
```

External data roots additionally require
`CONFIRM_EXTERNAL_PI_DATA_ROOT=1`. The reset refuses active writers and unsafe
paths, safely migrates scanned user Skills, and preserves profile/preferences,
User Space authority, tenant knowledge, Postgres, and control-plane state.

## SRT verification

The supported production runtime is Linux. Its pinned SRT workload runs in a
new PID namespace, so changing process group or calling `setsid(2)` cannot move
a descendant outside the lifecycle boundary. Pinned SRT 0.0.65 on macOS has no
equivalent boundary; Piwork rejects macOS and Windows before spawning the
session workload.

The runtime compiles one settings file per session. It denies the tenants root,
host user volumes, removable volumes, and shared temporary roots, then re-allows
only the current workspace, home, temporary directory, Pi config/session
directories, approved knowledge roots, and exact Node/Pi runtime.
Linux User Space file transfer uses a neutral
`user-space.piwork.internal` TLS/CONNECT route because SRT's seccomp filter
intentionally blocks workload-created AF_UNIX sockets. It uses only
Piwork-owned internal authority and cannot carry model traffic. The
generation-scoped capability is still mandatory. The policy grants writes only
to the five current-session runtime directories; private staging and Git
executable config remain denied. Missing policy, a non-exact SRT package
version, PATH-only SRT, or unsupported platform enforcement all fail closed.

Run the black-box canary inside the production container with an adjacent forbidden session path:

```bash
make test-srt-isolation SRT_CANARY_ARGS="\
  --settings /path/to/session/tmp/srt-settings.json \
  --writable /path/to/current/session/workspace \
  --knowledge /path/to/readonly/knowledge \
  --forbidden /path/to/another/session"
```

Also exercise the protected User Space transports as platform-specific
component canaries. Passing the macOS IPC canary does not override the launcher
process-containment gate:

```bash
make test-srt-user-space-ipc
make test-srt-user-space-transport
make test-srt-pi
```

The canary must demonstrate current-workspace write access, knowledge read access, knowledge write denial, and cross-session read denial.

## Skills and MCP

Skill imports require an HTTPS source, pinned commit, content digest, and bounded file snapshot. The scanner blocks path escapes, secret files, and missing `SKILL.md`, and flags executable, network, process-execution, and credential-related content. Enterprise/team skills remain pending until an administrator approves a passing scan; personal skills auto-approve only after a passing platform scan.

MCP secrets are AES-256-GCM envelopes bound to `tenantId:secretId`. API
responses return only metadata. Plaintext is delivered only through a
server-owned one-use Unix socket capability and never through Pi argv, files,
shell environment, logs, recordings, or JSONL. Each child Agent receives an
independent channel.

Piwork owns MCP stdio, SSE, and Streamable HTTP transports, including
status, enable/disable, cancellation, and reconnect. SDK transport
implementations are rejected. In Plan mode, only tools explicitly marked
`readOnly` may be exposed.
