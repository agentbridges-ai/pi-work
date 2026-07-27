# Native Pi RPC runtime

Piwork has one Agent backend: `@earendil-works/pi-coding-agent@0.82.1`
running its exported `rpc-entry` under Node.js >= 22.19.0. There is no
alternate Agent transport, SDK proxy, CLI WebSocket fallback, Pi fork, or
provider-specific fallback. `@modelcontextprotocol/sdk` is pinned to `1.29.0`
for schemas and protocol types; Piwork owns all MCP transports.

`can1357/oh-my-pi` is a design reference for ask, plan, todo, subagent, MCP, and
background-task behavior. It is not a runtime or build dependency. Any future
substantial source port must retain the upstream MIT attribution.

## Process topology

```text
Browser
  -> authenticated Bun/Hono WebSocket
  -> PiAdapter
  -> strict LF JSONL RPC transport
  -> one per-session SRT
  -> Node + Pi rpc-entry
  -> explicit Piwork trusted extension
```

Every live session owns one subprocess generation. Account, agent, and
session switches advance their generation token; results from an older
generation are discarded even if its process or network request completes
later. A child exit rejects every pending RPC request before a replacement
generation may become ready.

The minimum Pi argv is:

```text
--no-builtin-tools
--no-extensions
--no-skills
--no-prompt-templates
--no-themes
--no-approve
--extension <exact Piwork trusted extension>
--skill <each approved managed Skill>
--session-dir <current-session>/pi-sessions
```

Piwork also disables context-file discovery when it supplies its own system
context. Explicit resources remain loadable even though discovery is disabled.
Workspace `.pi`, project extensions, package installation, and `/login` are
not available. Pi is launched from the Agent Space workspace, while its
configuration and JSONL roots are the session-private `pi-config` and
`pi-sessions` directories.

## RPC framing and lifecycle

RPC is UTF-8 JSONL with LF (`0x0a`) as the only frame delimiter. Do not use a
generic line reader: U+2028 and U+2029 are legal inside JSON strings. A
transport must:

- attach a unique request ID and match exactly one response;
- accept multiple frames in one read and a frame split across arbitrary reads;
- apply stdin and stdout backpressure;
- bound each frame, aggregate stdout, and captured stderr;
- time out requests and process startup independently;
- tag events and pending requests with the subprocess generation;
- reject all pending work on exit, protocol corruption, or generation change;
- forward abort, retry cancellation, compaction, and history commands;
- terminate cleanly without accepting a non-LF trailing frame.

Browser `seq/ack/replay` is independent of child request IDs. It protects the
authenticated browser connection; child IDs protect the Pi transport.

## Readiness

A spawned process is not ready merely because it is alive. Readiness is the
conjunction of:

1. successful `get_state`;
2. successful available-model enumeration and policy filtering;
3. exact Pi JSONL history recovery, or confirmed new-session creation;
4. successful trusted-extension mode/status handshake;
5. a complete managed-MCP status snapshot.

Queued browser messages stay server-owned until all five gates pass. A failed
gate tears down the generation and clears its pending requests.

## History and data authority

The fixed session layout is:

```text
workspace/
home/
tmp/
pi-config/
pi-sessions/
recordings/
user-space-checkouts/
session.json
```

Pi JSONL is the only source of truth for conversation messages, selected model,
thinking level, compaction, Plan entries, and Todo custom entries.
`session.json` stores only product authority, archive state, the relative Pi
JSONL path, offline queue metadata, and client de-duplication state. It must not
duplicate messages or pending permissions.

Resume accepts one exact regular `.jsonl` file whose canonical path is inside
the current session's `pi-sessions` directory. Symlinks, partial IDs, glob
selection, another session's path, and non-Pi JSONL are rejected. History
pagination safely parses that file directly. A restored session is not ready
until replay and the other readiness gates complete.

The data root must contain `.runtime/runtime-layout.json` with the Pi v1 marker.
A brand-new empty root is initialized directly. A non-empty unmarked root
refuses session launch; it is never deleted or migrated automatically. Review
the explicit reset first:

```bash
make pi-reset-legacy-sessions
CONFIRM_PI_SESSION_RESET=1 make pi-reset-legacy-sessions
```

An external `PIWORK_DATA_ROOT` additionally requires
`CONFIRM_EXTERNAL_PI_DATA_ROOT=1`.

## Credentials and provider registration

Model and MCP credentials must not appear in argv, files, Pi settings, shell
environment, logs, recordings, or Pi JSONL. For each Agent generation, the
server creates a one-use Unix socket capability outside tenant-controlled
paths. The trusted extension connects, consumes the bounded bootstrap payload,
closes the socket, and registers the provider in memory. The server then
destroys the capability and socket. Replay never reconstructs a credential
from persisted state.

Each child Agent uses a separate one-use channel. Credentials are not inherited
through a parent environment and are never forwarded to bash, User Space,
agent-browser, or an MCP subprocess except through the MCP server's own
server-controlled secret handoff.

`GET /backends/pi/models?agentId=...` uses a short-lived, controlled Pi RPC
probe. The visible set is the intersection of:

- platform model allowlist;
- the Agent's `provider/model` glob allowlist;
- providers for which the server can inject credentials;
- the Agent/session network policy.

The endpoint returns model references, never credential material.

## Trusted extension and tools

The extension factory registers Pi-native `read`, `write`, `edit`, and `bash`
with operations constrained to authorized Agent Space roots. Their public
contracts retain Pi 0.82.1 behavior for truncation, `offset`/`limit`,
BOM/newline handling, atomic multi-edit, cancellation, and timeout. Generic
host paths and workspace-owned `.pi` resources are not accepted.

Product tools are:

- `ask`: single-select, multi-select, free input, cancel, and timeout over Pi's
  RPC extension UI request/response channel;
- `todo_write`: replaces the complete list and appends a Pi custom entry;
- `task`: foreground/background execution, stop, and live progress; at most
  four parallel child tasks per parent and depth two;
- `propose_plan`: execute, continue planning, or refine; only explicit execute
  confirmation changes the mode to Agent;
- `mcp__<server>__<tool>`: only tools from Piwork's managed MCP registry.

Child tasks inherit model, SRT, Skills, MCP policy, network policy, and mode.
They receive an independent bootstrap channel and process generation.

Managed MCP supports stdio, SSE, and Streamable HTTP. Piwork owns connection
state, enable/disable, reconnect, timeouts, and cancellation. SDK transport
implementations are not accepted.

## Agent and Plan modes

The only modes are `agent` and `plan`.

Plan mode fails closed:

- `write` and `edit` are unavailable;
- `task` is forced read-only;
- only MCP tools explicitly marked `readOnly` may run;
- bash passes a syntax-aware read-only classifier;
- dynamic execution, redirects, command substitution, or an unclassified
  command is rejected;
- User Space text reads use the exact
  `user-space read rootName/path [--offset N] [--limit N]` form. Metadata
  traversal uses one literal, allowlisted command through
  `user-space bash --command <command>`; neither form may be piped or combined,
  and the User Space broker authorizes it separately from Agent Space.

There is no pending-permission compatibility state. Execution begins only after
`propose_plan` receives explicit execute confirmation.

## Browser protocol and recordings

The browser protocol is Pi-shaped and accepts these core events:

- `agent_message`
- `message_delta`
- `tool_execution`
- `interaction_request` / `interaction_response`
- `run_state`
- `history_snapshot`

It retains sequence/ack/replay, lifecycle phases, and User Space messages.
Legacy-shaped dual protocol payloads are rejected.

Existing recording API paths and authentication remain stable. Raw recordings
contain redacted inbound/outbound Pi RPC JSONL, lifecycle transitions, and
trusted-extension events. They never include bootstrap payloads, credentials,
capability tokens, or protected file contents.

## Protected User Space transport

Linux SRT uses a neutral internal protected-file TLS/CONNECT route such as
`user-space.piwork.internal`. It accepts only the exact server-issued
generation capability and only User Space transfer endpoints. It does not
impersonate a model-provider hostname and cannot carry model traffic. The
agent-facing User Space contract remains `read`, `write`, `edit`, and `bash`.

## Verification

```bash
make verify-pi-versions
make test-pi-rpc-contract
make test-srt-pi
make test-srt-user-space-transport
make typecheck
make test-targeted
make test
make build
```

The RPC probe launches the real pinned `rpc-entry`, exercises split and
combined LF frames, request IDs, model and command enumeration, explicit
extension and Skill loading, exact JSONL resume, and clean shutdown. The Linux
smoke repeats that probe inside the real pinned SRT.
