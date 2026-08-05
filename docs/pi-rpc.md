# Native Pi RPC runtime

Piwork has one Agent backend: `@earendil-works/pi-coding-agent@0.82.1`
running its exported `rpc-entry` under Node.js >= 22.19.0. There is no
alternate Agent transport, SDK proxy, CLI WebSocket fallback, Pi fork, or
provider-specific fallback. `@modelcontextprotocol/sdk` is pinned to `1.29.0`
for schemas and protocol types; Piwork owns all MCP transports.

## Reference authority

The sole normative guide for Pi Agent and RPC development is the official
`earendil-works/pi` repository pinned as the read-only Git submodule at
[`docs/upstream/pi`](upstream/pi). It includes the complete upstream
documentation and the implementation context needed to interpret it; do not
copy only one page into a second Piwork authority. Start RPC work from
[`packages/coding-agent/docs/rpc.md`](upstream/pi/packages/coding-agent/docs/rpc.md).
The [published Pi RPC page](https://pi.dev/docs/latest/rpc) is a convenient
rendering of that upstream documentation.

Initialize, update, and verify the reference with:

```bash
git submodule update --init docs/upstream/pi
make sync-pi-upstream
make verify-pi-upstream
```

Do not edit the submodule from Piwork. An upstream update changes the
superproject gitlink and is reviewed like a dependency pin. The exact
`@earendil-works/pi-coding-agent@0.82.1` package installed by Piwork is used to
test compatibility with the pinned guide, not as a competing product-design
authority. A documented feature that is absent from 0.82.1 remains unavailable
until the runtime dependency is deliberately upgraded.

PiDeck, `ygncode/pi-web`, `agegr/pi-web`, Oh My Pi, OMP, Claude Code, and other
community products are idea and failure-mode references only. They may suggest
a case worth testing, but they do not define Piwork's wire protocol, lifecycle,
session authority, product surface, or UI. A community pattern is adopted only
after it is reduced to a stock-Pi RPC or Extension API behavior and verified
against the pinned official guide and runtime. Community renderer queues,
optimistic transcript state, session-file edits, Git/PTY surfaces, and runtime
forks must not become Piwork authority.

`can1357/oh-my-pi` is a design reference for ask, plan, todo, subagent, MCP, and
background-task behavior. It is not a runtime or build dependency. Any future
substantial source port must retain the upstream MIT attribution.

The same boundary applies to the [Pi package ecosystem](https://pi.dev/packages).
Piwork does not run `pi install`, enable package discovery, or load third-party
extension code directly. A reviewed package may contribute `SKILL.md` and its
supporting references to Piwork's governed managed-Skill store; Piwork
materializes the reviewed files under the session's immutable `pi-resources/`
and loads them only through explicit stock-Pi `--skill` arguments. Executable
capability remains in the trusted Extension API or Piwork-owned managed MCP
broker. This keeps Pi unmodified and avoids importing package credentials,
filesystem authority, or secondary state stores.

Claude Code and coding-first Pi derivatives are method references, not product
templates. Piwork adopts useful ideas such as isolated context, evidence-backed
completion, structured questions, and deterministic permission hooks. It does
not copy private prompts, tool names, Git/worktree/PR flows, host PTYs, LSP, or
debugger surfaces. The user-facing product remains paper-work, and the existing
Piwork conversation panel remains the browser projection of native Pi state.

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

The official interoperability guidance permits clients to strip a trailing CR
from CRLF input. Piwork intentionally exposes a narrower harness contract for
its pinned local child: generated input is LF-only, and child output containing
CRLF or an unterminated final frame is rejected. This is a documented
hardening constraint for Piwork's controlled transport, not a redefinition of
general Pi RPC.

Prompt and lifecycle handling follows the official semantics:

- a correlated `prompt` response with `success: true` means stock Pi accepted,
  queued, or handled the input; subsequent work remains asynchronous;
- `success: false` is a pre-acceptance rejection, while a transport failure
  after write is not proof that Pi rejected the prompt;
- a prompt sent while Pi is streaming needs the native
  `streamingBehavior: "steer" | "followUp"` contract; Piwork does not emulate a
  second steering/follow-up queue in the browser;
- `agent_end` is only one low-level run boundary. `agent_settled` is the final
  boundary after automatic retry, automatic compaction, and queued
  continuations;
- manual compaction is a separate RPC operation whose `compaction_end` and
  command response terminate that operation. Automatic compaction inside an
  agent run does not make the run settled;
- extension dialog requests are correlated by their exact request ID and
  generation. Reconnect snapshots only mirror still-live requests; Pi remains
  the request owner and applies its own timeout.

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
- `todo_read`: reconstructs the current list after resume, branch, or
  compaction from the same Pi session entries;
- `task`: foreground/background execution plus `list`, `status`, `wait`,
  `steer`, and `stop`; at most four parallel child tasks per root session and
  depth two;
- `propose_plan`: execute, continue planning, or refine; only explicit execute
  confirmation changes the mode to Agent;
- `mcp__<server>__<tool>`: only tools from Piwork's managed MCP registry.

Child tasks inherit model, SRT, Skills, MCP policy, network policy, and mode.
They receive an independent bootstrap channel and process generation. A task
does not become terminal at `agent_end`: Piwork waits for Pi's
`agent_settled`, after retries, compaction, and queued continuation. Background
results are bounded, retained in memory for task queries, and queued into the
owning parent through Pi's native `prompt` command with
`streamingBehavior: "followUp"` (queue while busy, start a turn while idle); a
running child is redirected through Pi's native `steer`. The trusted
notification marks child output as untrusted evidence before it enters the
parent context. Entering Plan mode stops any still-live child with a writable
Agent Space capability. The transition fails closed until Piwork confirms the
OS process exited; a failed termination remains registered and cannot masquerade
as a successful retry.

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

The exact browser projection, event classification, orthogonal runtime state,
and development scenario requirements are defined in
[`pi-native-projection.md`](./pi-native-projection.md). Live events, restored
history, and recording replay must pass through that same projection contract.

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
make verify-pi-upstream
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
