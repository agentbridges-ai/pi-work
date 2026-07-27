# AGENTS.md

This file guides coding agents working in this repository.

## Evidence Before Repeated Guessing

When a problem remains unresolved after repeated hypothesis-driven attempts,
stop making local speculative changes. Search the authoritative upstream
implementation, upstream issues and discussions, and relevant community reports
for an established model or fix. Build a minimal reproduction or comparison
against that evidence before changing the product again. Do not treat a changed
symptom (for example, an error glyph becoming blank) as a successful fix.

## What This Is

Piwork is a local multi-user agent workbench powered by native Pi.
Better Auth + Postgres is the user entry point. Better Auth owns users,
accounts, credentials, and sessions; Piwork stores product runtime state under
the repo root `data/` directory:

Piwork is a paper-work product. Preserve Pi's native Agent capabilities,
including its ability to code inside the isolated session workspace, but do not
build product-level Git, worktree, pull-request, source-code dashboard, or host
PTY workflows. Coding may be an implementation means for a agent;
it is not a user-facing product goal. The browser-backed User Space `just-bash`
shell and Wterm surface remain supported document/file operations and are not a
host terminal.

```text
Browser
  -> Vite frontend
  -> local Bun/Hono API + WebSocket server
  -> Better Auth user.id
  -> data/<betterAuthUserId>/<sessionId>/...
  -> PiAdapter + strict LF JSONL RPC
  -> one Node + native Pi rpc-entry inside a per-session SRT
  -> explicit trusted Piwork extension
```

The development-stage isolation boundary is Better Auth session auth plus
filesystem scope: one user maps to `data/<betterAuthUserId>/`, and one session
maps to `data/<betterAuthUserId>/<sessionId>/`. Do not reintroduce Kubernetes,
Docker image-build, model-service, LDAP, token-only local auth, or user-pod
paths.

## Development Commands

```bash
make install
make auth-migrate
make dev
make dev-fast-stop

make typecheck
make test-targeted
make test
make test-pi-rpc-contract
make test-srt-pi
```

`make dev` requires `DATABASE_URL`, checks Postgres connectivity, starts local
Bun API on `PORT` (default `3457`) and Vite on `VITE_PORT` (default `3458` or
the next free port). `data/` is created automatically and is ignored by Git.

Use `make pi-reset-legacy-sessions` to review the mandatory native-Pi migration.
Applying it requires `CONFIRM_PI_SESSION_RESET=1`; an external data root also
requires `CONFIRM_EXTERNAL_PI_DATA_ROOT=1`. The command refuses active writers,
unsafe paths, and unsafe legacy Skills. It preserves Better Auth/Postgres,
profiles, preferences, User Space authority, tenant knowledge, and control
plane configuration.

## Current Architecture

```text
Local server
  - Better Auth native routes at /api/auth/*
  - /api/auth/mode and /api/me app compatibility routes
  - per-user runtime registry keyed by Better Auth user.id
  - per-session API and Pi-shaped browser WS routing
  - one native Pi JSONL RPC child generation per session
  - one-use credential bootstrap and Piwork-managed MCP

Postgres
  - Better Auth users/accounts/sessions only

User data
  - data/<betterAuthUserId>/profile.json
  - data/<betterAuthUserId>/workspace-state.json
  - data/<betterAuthUserId>/preferences.json
  - data/<betterAuthUserId>/pi-resources/skills

Session data
  - data/<betterAuthUserId>/<sessionId>/workspace
  - data/<betterAuthUserId>/<sessionId>/home
  - data/<betterAuthUserId>/<sessionId>/tmp
  - data/<betterAuthUserId>/<sessionId>/pi-config
  - data/<betterAuthUserId>/<sessionId>/pi-sessions
  - data/<betterAuthUserId>/<sessionId>/recordings
  - data/<betterAuthUserId>/<sessionId>/user-space-checkouts
  - data/<betterAuthUserId>/<sessionId>/session.json
```

## Main Code Areas

- `web/server/index.ts` - local Bun/Hono entrypoint.
- `web/server/better-auth.ts` - Better Auth + Postgres configuration.
- `web/server/local-auth.ts` - Better Auth session to Piwork user adapter.
- `web/server/local-user-profile-store.ts` - derived `profile.json` snapshots.
- `web/server/local-runtime-registry.ts` - per-user runtime and session router.
- `web/server/local-paths.ts` - canonical `data/<betterAuthUserId>/<sessionId>` paths.
- `web/server/session-store.ts` - session directory enumeration and persistence.
- `web/server/pi-session-preparer.ts` - governed Pi session resources and SRT policy.
- `web/server/pi-launch-options-builder.ts` - pinned authority, model policy, and launch materialization.
- `web/server/pi-adapter.ts` - Pi/browser message and lifecycle adaptation.
- `web/server/pi-rpc-transport.ts` - strict JSONL process transport.
- `web/server/pi-bootstrap-channel.ts` - one-use in-memory provider bootstrap.
- `web/server/pi-trusted-extension.ts` - trusted tools, modes, and product interactions.
- `web/server/managed-mcp.ts` - managed stdio/SSE/Streamable HTTP MCP.
- `web/server/ws-bridge.ts` - Pi-only browser protocol, replay, and interaction state.
- `web/src/components/LoginPage.tsx` - Better Auth email/password login and registration.
- `web/src/api.ts` - cookie-authenticated browser API client.
- `web/src/ws.ts` - browser WebSocket client.
- `web/src/store/` - Zustand runtime state slices.

## Testing

- New backend and frontend behavior should include focused tests when possible.
- New or modified message/chat UI components should include focused component
  tests; do not add product-unrelated static demo or playground routes.
- Keep tests for still-supported behavior. When removing a feature, remove or
  rewrite tests that only validate that removed feature.
- Prefer the existing Vitest patterns in `web/server/*.test.ts` and
  `web/src/**/*.test.tsx`.

### Frontend i18n harness

- Every user-visible frontend string must come from `web/src/ui-copy.ts`,
  including visible text, error and empty states, status labels, placeholders,
  `title`, `aria-label`, and fallback copy. Do not add literal product copy in
  production TSX.
- Add the Simplified Chinese value to `zhCNCopy` and the English value to
  `enUSCopyOverrides` in the same change. Brand names, protocol names, command
  names, paths, and other intentionally invariant technical literals are the
  only exceptions and must be explicitly allowlisted by path in
  `web/src/i18n-harness.test.ts`.
- Read `uiCopy` at render or action time so live language switching uses the
  active catalog. Do not snapshot localized strings into module-scope constants.
- New or changed UI behavior must test the relevant Chinese and English copy.
  `web/src/i18n-harness.test.ts` rejects production TSX hardcoded copy and
  untranslated static catalog entries; keep this guard in the targeted test run.

Useful checks:

```bash
make typecheck
make test-targeted
make test
```

## Product Rules

- Better Auth + Postgres is the product auth path. Do not reintroduce LDAP,
  signed-token-only local auth, or browser localStorage bearer-token auth.
- Better Auth `user.id` is the local isolation id and is exposed as
  `CurrentUser.uuid` for existing app code.
- `data/<betterAuthUserId>/<sessionId>/session.json` is the source of truth for
  product authority, archive state, the relative Pi path, offline queue
  metadata, and client de-duplication. The exact Pi JSONL below that session's
  `pi-sessions/` is the only history, model, compaction, Plan, and Todo
  authority.
- Frontend must not persist session/agent authority in localStorage.
- Browser-mounted user-space directories follow the
  [abaveja313/conduit](https://github.com/abaveja313/conduit) split: File System
  Access API owns permission and handle traversal; background workers plus the
  TypeScript index own metadata indexing, filtering, pagination, and search.
  The underlying index must enumerate the authorized directory completely,
  without depth, dot-prefixed hidden path, directory-name, or file size filters;
  `.git`, `node_modules`, and `dist` are indexed too. File trees and default
  search hide dot-prefixed paths at the presentation/search layer, and user
  preferences can independently enable hidden entry display and hidden entry
  search. Preload file contents only for the runtime content index whitelist
  `txt/js/ts/css/html/json`; read other concrete content only for preview,
  `read_file`, blob checkout/checkin, or write conflict checks.
  Closing preview tabs must revoke blob/object URLs and must not leave `File`
  snapshots retained in memory.
  The user-space CLI uses `just-bash/browser` only as the shell/parser/pipeline
  layer. Do not mirror user directories into an in-memory FS. Metadata-only
  recursion such as `tree` and the v1 `find` subset may enumerate the complete
  TypeScript index and should apply the user's hidden-entry preferences.
  The Agent-facing top-level CLI is limited to pi-aligned `user-space read`,
  `write`, `edit`, and `bash`. Recursive content search stays on the browser
  file-tree index through `grep -r/-R` inside that bash; the indexed `glob`
  command owns recursive path matching, while `find` and `tree` own metadata
  traversal. `search`, `search_paths`, and
  `glob` are internal index APIs, not public top-level CLI commands.
  Do not reintroduce host `grep`, `rg`, `find`, `xargs`,
  network, Python, JS exec, SQLite, tar, or similar heavy shell surfaces into
  the v1 whitelist.
  User Space exposes one active directory. Directory identifiers,
  `user-space use`, `--mount`, and `name:/path` are not public Agent surfaces.
  Text files normally remain remote and use read/write/edit. Binary files use
  `checkout rootName/USER_SPACE_PATH` inside user-space bash, then normal Agent
  Space tools operate on the exact session-relative `shared/...` path returned
  by checkout. `checkin shared/PATH rootName/USER_SPACE_PATH` safely replaces
  an explicit User Space destination; omitting the destination creates a
  non-destructive result in User Space `shared/`. Inside user-space bash, `/`
  is already the active User Space root and Agent Space `shared/...` is not
  visible. Private staging lives under the session's `user-space-checkouts`
  directory and must never be exposed as an Agent-visible host path.
- The authoritative harness reference for User Space tools is
  [earendil-works/pi](https://github.com/earendil-works/pi) `main`, specifically
  `packages/coding-agent/src/core/tools/read.ts`, `write.ts`, `edit.ts`,
  `edit-diff.ts`, `bash.ts`, `truncate.ts`, `output-accumulator.ts`, and
  `file-mutation-queue.ts`. Keep the public `user-space read`, `write`, `edit`,
  and `bash` contracts, truncation and continuation notices, exact-edit
  matching, multi-edit atomicity, line-ending/BOM behavior, mutation
  serialization, timeout behavior, and errors aligned with those sources.
  Piwork may replace only the operations layer: text files remain remote in
  the browser File System Access API and bash runs through
  `just-bash/browser`. Do not introduce MCP, host paths, session text
  checkouts, or a second incompatible set of line-range/edit arguments.
  `read` line ranges use pi's 1-based `offset` plus `limit`; never teach the
  Agent to pipe `user-space read` through `sed`, `head`, or `tail`.
  Treat `user-space bash` as a bounded browser file shell, not a generic Bash:
  the canonical command registry and execution limits live in
  `web/src/user-space-shell-contract.ts`, and `user-space bash --capabilities`
  must expose that same contract. Do not teach or attempt unregistered external
  executables, networking, sockets, package managers, VCS, compilers,
  databases, language runtimes, host process control, or host paths. Keep
  command-specific restrictions, the four-tool top-level surface, and binary
  `checkout`/`checkin` behavior explicit in Agent prompts and development docs.
- The authoritative User Space search reference is
  [DannyMoerkerke/file-tree](https://github.com/DannyMoerkerke/file-tree)
  `master`, especially `src/iterateWorker.js`, `src/file-tree.js` methods
  `indexDirectory`, `indexFileContent`, `findInFiles`, `searchInFiles`,
  `findFile`, and `searchFile`, plus their tests. Search must recursively index
  and query the browser-authorized directory through a background Worker.
  Piwork intentionally keeps metadata for every directory and file (including
  `.git`, `node_modules`, `dist`, and dot-prefixed paths), applies hidden-path
  preferences only at presentation/query time, and adds pagination, structured
  line matches, grep formatting, and glob matching. `grep -r/-R` inside
  `user-space bash` is driven by this index; non-recursive grep remains the
  just-bash explicit-file/stdin command. The bash-internal `glob`, `find`, and
  `tree` commands consume the indexed path set. Do not expose redundant top-level
  grep/glob/search commands and never describe recursive search as unsupported.
- Account switching, agent switching, and session switching should be driven
  by one controlled async flow, with stale operations ignored.
- During local development, model and MCP credentials may be stored only in the
  Git-ignored root `.env`, which must remain mode `600` and must never be
  committed. Do not store them in session files. The local launcher must remove
  credentials from the API and child Agent environment before handing them to
  the trusted extension through a one-use Unix socket; consume and destroy the
  capability, then register the provider in memory. Never place credentials in
  argv, logs, recordings, Pi JSONL, or a child Agent's inherited environment.
- `agentbridges-ai/onlyoffice-browser` is maintained by the same organization
  and is part of this product surface. For OnlyOffice behavior changes, use the
  repo-local monorepo checkout at `onlyoffice-browser/` instead of adding
  workaround patches in Piwork; this directory is intentionally ignored by
  Git and prepared by `make onlyoffice-browser`. After user verification, push
  the upstream change and publish the updated npm package.
- OnlyOffice-related shipping spans three repositories. When changes touch this
  surface, commit and push any updated `agentbridges-ai/onlyoffice-x2t-wasm`,
  `agentbridges-ai/onlyoffice-browser`, and `agentbridges-ai/Piwork` working
  trees. Publish npm only for `@agentbridges-ai/onlyoffice-browser`; do not
  publish a Piwork npm package as part of this flow.
- OnlyOffice has two different browser outputs. `dist/npm/public-api.js` is the
  Piwork-facing proxy API, but the editor iframe actually runs
  `dist/assets/officeHost-*.js`. If a change touches
  `onlyoffice-browser/src/lib/office-editor-runtime.ts`, verify the rebuilt host
  bundle, not just TypeScript tests or `build:lib`: run
  `./scripts/ensure-onlyoffice-browser.sh`, confirm the expected runtime
  signature exists in `onlyoffice-browser/dist/assets/officeHost-*.js`, then
  reload or reopen the Office iframe before Chrome verification. Stale open
  iframes keep the old host bundle even when files on disk are correct.
- Piwork must serve the compact OnlyOffice runtime profile from the external
  `onlyoffice-browser/` checkout. The prepared `onlyoffice-browser/dist` must
  contain `onlyoffice-runtime-assets.json` and exclude bundled PDF/Visio SDKs,
  package fonts, FileConverter font assets, non-selected dictionaries, and
  bundled help image trees. Generated development fonts are served from
  `onlyoffice-browser/.onlyoffice-font-assets/` as an overlay; do not vendor
  them or the full upstream editor asset tree into Piwork.
- Treat [ONLYOFFICE/DocumentServer](https://github.com/ONLYOFFICE/DocumentServer)
  as the authoritative upstream reference for OnlyOffice save, print,
  conversion, document-resource, editor iframe, and callback/storage behavior.
  Before fixing a non-trivial OnlyOffice issue, inspect the relevant
  DocumentServer implementation path first and align `onlyoffice-browser` with
  that model where the browser-only constraints allow it. Use
  [ONLYOFFICE/Docker-DocumentServer](https://github.com/ONLYOFFICE/Docker-DocumentServer)
  only for container/runtime wiring and deployment context; prefer
  DocumentServer for product behavior.
- Use [agentbridges-ai/onlyoffice-x2t-wasm](https://github.com/agentbridges-ai/onlyoffice-x2t-wasm)
  as the maintained fork for browser x2t/WebAssembly build changes and
  releases. Use [cryptpad/onlyoffice-x2t-wasm](https://github.com/cryptpad/onlyoffice-x2t-wasm)
  only as a source-analysis reference for runtime filesystem, test wiring, and
  wasm packaging constraints. Do not patch or publish the CryptPad upstream;
  product behavior still follows ONLYOFFICE/DocumentServer.
- Keep browser-side Office conversion on the x2t-wasm path only. Do not add a
  second conversion engine, Pandoc path, or fallback converter for Office
  Download As, including Markdown, HTML, EPUB, FB2, PDF, image, or text
  exports. Post-processing is allowed only after x2t-wasm has already produced
  the requested target bytes, for example packaging Markdown image resources. If
  x2t-wasm cannot produce a format, fix `agentbridges-ai/onlyoffice-x2t-wasm` or
  surface the real conversion error.
- AgentMode is exactly `agent | plan`. Plan mode must fail closed: no
  write/edit, child tasks stay read-only, only explicitly read-only MCP tools
  run, and bash rejects redirects, dynamic execution, and unclassified syntax.
- Keep editor endpoints disabled unless routed through the authenticated local
  server.

## Browser Exploration

Use the Codex Chrome plugin for browser exploration and verification.

## Review guidelines

- Report only actionable defects introduced by the pull request. Do not report
  style preferences, pre-existing issues, or speculative risks without a
  concrete failing path.
- Treat any cross-user data exposure, authentication bypass, credential leak,
  path traversal outside `data/<betterAuthUserId>/<sessionId>/`, or unauthenticated
  editor endpoint as P1 or higher.
- Verify that account, agent, and session switches cannot commit stale async
  results and that browser state does not become an authority for user or session
  identity.
- For User Space changes, enforce the four-tool Agent surface, browser-owned file
  access, complete metadata indexing, presentation-time hidden-path filtering,
  bounded `just-bash/browser` commands, and blob URL cleanup described above.
- For frontend changes, flag user-visible strings that bypass `ui-copy.ts`, omit
  either Chinese or English copy, or break live language switching. Require
  focused component tests for changed chat or message behavior.
- For Pi RPC changes, verify strict LF framing, request IDs, split/coalesced
  frames, backpressure, bounds, timeouts, generations, pending cleanup,
  reconnect, cancellation, exact JSONL resume, and raw protocol recording
  against Pi 0.82.1. Reject legacy-shaped dual protocols and fallbacks.
- For OnlyOffice changes, flag Piwork-side workarounds for behavior owned by
  `onlyoffice-browser`, alternate conversion engines, expanded runtime assets,
  or verification that checks only the proxy bundle while leaving the iframe
  host bundle stale.
- Check that new behavior has focused regression coverage and that repository
  quality gates remain reachable through the documented `make` targets.

## Raw Protocol Recordings

The local runtime can record redacted bidirectional Pi RPC JSONL, lifecycle
transitions, and trusted-extension events for debugging and replay-oriented
tests. Credentials, bootstrap payloads, capabilities, and protected file
contents must never be recorded.

- Default location: `data/<betterAuthUserId>/<sessionId>/recordings/`.
- Disable with `PIWORK_RECORD=0` or `PIWORK_RECORD=false`.
- APIs:
  - `GET /api/recordings`
  - `GET /api/sessions/:id/recording/status`
  - `POST /api/sessions/:id/recording/start`
  - `POST /api/sessions/:id/recording/stop`

## Native Pi

The only Agent runtime is `@earendil-works/pi-coding-agent@0.82.1` through its
exported `rpc-entry` under Node.js >= 22.19.0.
`@modelcontextprotocol/sdk` is exactly 1.29.0. Do not add a Pi fork, a
`@mariozechner` Pi package, alternate Agent transport, SDK proxy, CLI
WebSocket, or model-provider fallback. Pi's sole upstream optional
`@mariozechner/clipboard@0.3.9` is allowed in the lockfile, never as a direct
dependency or production import.

Always launch with discovery and trust disabled:
`--no-builtin-tools --no-extensions --no-skills --no-prompt-templates
--no-themes --no-approve`, followed by exact explicit paths for the Piwork
trusted extension and approved managed Skills. Workspace `.pi`, project
extensions, package installation, and `/login` remain disabled.

Pi JSONL below the current session's `pi-sessions/` is the only source of truth
for messages, model, thinking, compaction, Plan, and Todo. `session.json` stores
only product authority, archive state, the relative Pi path, offline queue
metadata, and client de-duplication. A non-empty data root without the Pi v1
`.runtime/runtime-layout.json` marker refuses session launch; never delete or
migrate it automatically.

`can1357/oh-my-pi` may be consulted only as a design reference for ask, plan,
todo, subagent, MCP, and background tasks. It must not become a dependency. If
source is substantially ported, preserve its MIT attribution.
