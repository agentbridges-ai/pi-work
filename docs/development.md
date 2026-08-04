# Development Workflow

Piwork's default local deployment is a fixed single-node Compose stack. Bun
runs Web/Hono and Vite, while a separate non-root Runtime container launches
the pinned Node + native Pi process inside one SRT per session. Better Auth +
Postgres provides authentication; Piwork product state stays in tenant-scoped
`data/`.

```bash
make install
make selfhost-init
make dev
```

Open the Frontend URL printed by `make dev`.

## Linux execution host

Piwork's complete local runtime must run on Linux. The SRT policy can enforce
filesystem and network rules on macOS, but only Linux provides the PID namespace
needed to contain every Pi descendant process. Keep the entire local runtime in
one Linux environment so session paths, one-use Unix sockets, process signals,
and the protected User Space transport never cross a host/guest boundary.

| Host OS | Linux development runtime | Host responsibilities          |
| ------- | ------------------------- | ------------------------------ |
| macOS   | OrbStack Linux machine    | IDE, browser, Chrome extension |
| Windows | WSL2 Linux distribution   | IDE, browser, Chrome extension |
| Linux   | Native Linux              | IDE, browser, Chrome extension |

Inside Linux, run Bun, Node, SRT, Pi, Postgres, `make install`, `make migrate`,
`make dev`, and the SRT canaries. Keep the checkout and `data/` on the Linux
filesystem rather than a host-mounted path where possible; this avoids VM/WSL
filesystem performance and path-identity surprises. The browser can still use
the host's Chrome and File System Access API through the forwarded API/Vite
ports.

Do not reuse a host `node_modules` directory inside Linux. Run `make install`
inside the Linux runtime so Bun installs private package metadata with the
repository's SRT trust settings.

On macOS, open the checkout from an OrbStack Linux shell and run the commands
there. On Windows, verify the distribution is WSL2 with `wsl -l -v`, then open a
WSL2 shell and run the commands there. WSL2 forwards Linux listening ports to
Windows `localhost` on supported Windows versions; OrbStack should expose the
configured API/Vite ports to the host as part of its Linux machine networking.

For a new Windows host, the Microsoft-documented starting point is
`wsl --install -d Ubuntu`; confirm the result with `wsl -l -v` and convert the
distribution with `wsl --set-version <Distro> 2` when necessary. For a new
macOS host, create/start an OrbStack Linux machine and use its Linux shell for
the checkout and all commands below.

The Chrome extension bridge is also a host/guest boundary: keep
`PIWORK_AGENT_BROWSER_BRIDGE_PORT` stable and verify that the Linux bridge port
is reachable from host Chrome. Do not weaken the bridge or SRT policy by binding
internal capability transports to a public interface. macOS Keychain is not
available inside the Linux runtime, so use the documented one-use provider
bootstrap from inside Linux rather than forwarding Keychain credentials.

Useful host references: [OrbStack](https://orbstack.dev/) and Microsoft's
[WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install).

## Official Pi development guide

The only normative Agent/runtime guide is the official `earendil-works/pi`
repository pinned at [`docs/upstream/pi`](upstream/pi). Initialize it after
cloning Piwork:

```bash
git submodule update --init docs/upstream/pi
make verify-pi-upstream
```

Use `make sync-pi-upstream` to advance the gitlink to the latest official
`main`, then review that dependency-pin diff before adapting Piwork. For RPC
work, begin with
[`packages/coding-agent/docs/rpc.md`](upstream/pi/packages/coding-agent/docs/rpc.md),
but use the rest of the same upstream repository when the behavior crosses
extensions, Skills, packages, sessions, compaction, providers, or tools.
Community projects may identify cases worth testing; they are not protocol or
product authorities.

## Service Split

```text
Browser
  -> Caddy (only published port)
  -> Vite source frontend / Web API

Web container (Bun/Hono, OrbStack/WSL2 on non-Linux hosts)
  -> Better Auth routes at /api/auth/*
  -> /api/auth/mode and /api/me app routes
  -> per-user runtime registry keyed by Better Auth user.id
  -> Pi-shaped browser WebSocket
  -> private HMAC Unix JSONL Runtime socket

Runtime container (Node >=22.19 + Pi + SRT)
  -> one Pi rpc-entry generation per session
  -> tenant/user/membership/org/session/generation scope
  -> no Postgres, TCP listener, or Docker Socket

Postgres
  -> Better Auth users/accounts/sessions and tenant control plane
  -> RLS through the non-owner Web role

Filesystem state
  -> data/tenants/<tenantId>/users/<userId>/...
  -> data/tenants/<tenantId>/users/<userId>/sessions/<sessionId>/...
```

## Commands

```bash
make dev           # verified Compose source stack
make dev-fast      # alias for make dev
make dev-fast-stop # stop local dev processes
make dev-native    # explicit in-process native Pi debug path
make selfhost-doctor
make selfhost-up
make selfhost-down
make selfhost-backup
make selfhost-upgrade
make status        # check local API and frontend
make agent-browser-e2e # real Mac Chrome extension bridge smoke test

make auth-generate # generate Better Auth SQL schema
make auth-migrate  # apply Better Auth schema to Postgres

make typecheck
make lint
make format-check
make deadcode
make dry-check
make test-targeted
make verify-pi-upstream
make verify-pi-only-runtime
make test-pi-rpc-contract
make test-srt-pi
make test-srt-user-space-transport
make test
make build
make check        # quality gates + targeted tests + production build
make verify       # frozen install + all gates + full release verification
```

All CI and development Linux runtimes use the same checked-in Node.js `26.5.0`
and Bun `1.3.9` setup.
The supported Node.js runtime floor remains `>=22.19.0`, matching the pinned Pi
package. `make verify-pi-versions` rejects dependency or `rpc-entry` drift
before the RPC and SRT probes run. `make verify-pi-only-runtime` rejects
removed runtime files and legacy transport/configuration vocabulary in
production source.

Run `make format` to apply the repository Prettier configuration. Generated,
vendored, runtime, and policy-owned files are excluded explicitly; CI and the
pre-commit hook use `make format-check` and never rewrite files.

`make dev-native` writes process ids and logs under `.runtime/`. Compose state is
managed by `scripts/selfhost.sh`; use `selfhost status` rather than treating
container PIDs as application authority.

## Compose release and security gate

Source mode builds only the fixed Web and Runtime images and keeps Vite HMR
inside the stack. Release mode reads `release/piwork-compose-release-manifest.json`
(or `PIWORK_RELEASE_MANIFEST`) as its single image source and requires every
image reference to be an immutable `@sha256:` digest. Run
`make selfhost-release-validate` before a release deployment. Caddy
is the only service with a host port; Runtime is non-root, read-only-rootfs,
`cap_drop: ALL`, `no-new-privileges`, bounded by PID/memory limits, and uses the
checked-in seccomp profile. `doctor --require-verified` rejects privileged mode,
host networking, extra capabilities, writable rootfs, unconfined seccomp, and
Docker Socket mounts, then runs the nested-SRT and per-session isolation canary.

`selfhost backup` stops Web/Runtime before writing a pg_dump and data snapshot;
the manifest and SHA-256 file never include the Runtime control key, database
application password, or other secret files. `selfhost restore` verifies both
before replacing the fixed data volume and restoring the database.

The old native process files are still used by `make dev-native`:

- `.runtime/server.log`
- `.runtime/vite.log`
- `.runtime/server.pid`
- `.runtime/vite.pid`
- `.runtime/ports.env`

## Environment

Start from `.env.example` and copy only the values you need.

Important variables:

- `DATABASE_URL` - required Postgres connection string for Better Auth.
- `PIWORK_POSTGRES_DATA_DIR` - explicit local Postgres data directory used only
  by the optional `make dev-native` auto-start path; Compose uses its Postgres
  service volume.
- `PIWORK_PG_CTL_BIN` - explicit absolute path to the matching `pg_ctl`
  executable. Both Postgres path variables are required for the native path;
  the launcher does not infer `PGDATA`, `PATH`, or a package-manager
  installation.
- `BETTER_AUTH_SECRET` - required in shared/dev-like environments; generate with `openssl rand -base64 32`.
- `BETTER_AUTH_URL` - API base URL, usually `http://127.0.0.1:3457`.
- `PORT` - Bun API port, default `3457`.
- `VITE_PORT` - Vite port, default `3458`.
- `PIWORK_DATA_ROOT` - local data root, default repo `data/`.
- `PIWORK_AGENT_BROWSER_DIR` - optional local checkout for the pinned `agent-browser` source; defaults to repo `agent-browser/`.
- `PIWORK_AGENT_BROWSER_ENABLED` - enable the Chrome bridge runtime; defaults to `1`.
- `PIWORK_AGENT_BROWSER_BRIDGE_PORT` - loopback bridge port; defaults to `19826`.
- `PIWORK_SESSION_SANDBOX` - defaults to `srt`; the launcher accepts only the
  repo-local pinned package and a server-generated principal policy. Enforced
  session launch requires Linux. Native macOS and Windows entrypoints fail
  closed and direct development must move into OrbStack Linux or WSL2 Linux.
- `PIWORK_PI_MODEL_ALLOWLIST` - platform-level `provider/model` glob
  allowlist. The final visible set is its intersection with Agent policy,
  injectable providers, and the Agent network policy.
- `PIWORK_SRT_ALLOWED_DOMAINS` - platform network ceiling for the
  session. Provider and MCP access must also be admitted by Agent policy.

Provider and MCP credentials are control-plane secrets, not `.env` values for a
Pi child. The server hands a bounded payload to the trusted extension over a
one-use Unix socket. The capability and socket are destroyed after consumption,
and the extension registers the provider in memory. Never add a credential to
Pi argv, files, shell env, logs, recordings, JSONL, or inherited child-task env.

Linux SRT runs the workload in a PID namespace, which gives the launcher a
kernel-owned lifetime boundary for every descendant. Pinned SRT 0.0.65 on
macOS provides Seatbelt filesystem/network rules but no equivalent descendant
process boundary: a process can create a new session and survive the SRT CLI.
Piwork therefore refuses macOS and Windows SRT session launches before the
Pi process is spawned. The server, frontend, and Pi session are developed
together inside OrbStack Linux or WSL2 Linux on those host operating systems.

There is no unsandboxed Agent runtime escape hatch. Development that needs to
execute a Pi session uses the supported Linux SRT path inside the host's Linux
VM or WSL2 distribution.

The browser ownership state machine, page boundary, dual dispatch fences, and
real-browser verification obligations are defined in
[`docs/agent-browser-control-loop.md`](./agent-browser-control-loop.md).

On Linux, the sandboxed User Space helper uses the neutral internal
`user-space.piwork.internal` TLS/CONNECT route because SRT blocks
workload-created AF_UNIX sockets. The proxy accepts only the exact internal
authority and protected file-transfer endpoints; it never impersonates a model
provider or carries model traffic. The generation-scoped User Space capability
remains mandatory, and the ordinary browser listener does not serve
`/internal/*`.

`make dev` and `make dev-compose` run the fixed Compose source stack through
`scripts/selfhost.sh`; Caddy is the only published port and the Web/Runtime/
Postgres services stay on the Compose networks. `make dev-native` is the
explicit Linux-only debug path: it sources root `.env`, validates
`DATABASE_URL`, and may start local Postgres with the explicitly configured
`PIWORK_POSTGRES_DATA_DIR` and `PIWORK_PG_CTL_BIN`. There is no `PGDATA`,
`PATH`, or Homebrew fallback. A failed native start can recover a stale
`postmaster.pid` only after confirming its PID is not Postgres and the
configured endpoint is not accepting connections; the lock is moved to
`.runtime/` rather than deleted. It never installs Postgres or attempts to
start a service for a remote database URL.

## Agent browser bridge

The first Mac delivery uses one browser route: structured `agent-browser`
actions over the Chrome extension/CDP provider. CUA and raw CDP fallbacks are
deliberately outside this release. Session launch installs a session-bound
`agent-browser` wrapper and `piwork-browser` skill; the wrapper fixes the
provider and session identity so one Pi session cannot select another
bridge transport or socket.

The hand-eye turn is bounded as:

```text
snapshot -> structured action -> semantic readback -> result
```

CDP events may decide when to sample, but they do not prove business success. A
click, fill, type, or press is complete only when semantic page readback
establishes the intended postcondition. External business commitment still
requires an authoritative API or product-state readback when the page alone
cannot prove it.

Prepare and test the pinned runtime with:

```bash
make agent-browser
make agent-browser-verify
make agent-browser-e2e
```

The checked-in release manifest pins the feature commit and CLI version. The
E2E command launches a fresh real Chrome profile with the unpacked MV3
extension, verifies the real Piwork bridge service, crosses the loopback
daemon and provider, performs snapshot/fill/type/press/click, and asserts
semantic readback. It fails if the extension does not connect; there is no mock
bridge fallback.

Runtime ownership is split intentionally:

- Piwork owns the loopback bridge daemon and exposes sanitized readiness
  through `/api/browser-bridge/*`.
- Each Pi session owns a unique short-path agent-browser Unix socket
  directory under the server-owned short temporary root. Only the session's
  exact socket and stream paths are added to the sandbox policy.
- kill, archive, delete, and runtime disposal close session browser state so
  the agent-browser daemon cannot outlive the Piwork lifecycle unnoticed.
- The UI reports artifact, daemon, and extension state without exposing tab
  URLs or page content.

## OnlyOffice Deployment Boundary

Piwork does not build or serve the OnlyOffice Host, SDK, WASM, dictionaries, or
font assets. Each editor uses an isolated
`https://office-editor-<session>.getpi.work/office-host.html` Host and loads
shared resources from `https://onlyoffice.getpi.work/`.

OnlyOffice runtime and font changes are developed, tested, and deployed from
the `onlyoffice-browser` repository. Piwork consumes its published npm client
API and pins the expected deployed runtime identity in the release manifest.
`make dev`, `make build`, and `make status` neither require a local
`onlyoffice-browser` checkout nor block on the remote deployment.

## OnlyOffice Save Chain

`@agentbridges-ai/onlyoffice-browser` is a browser-only editor wrapper. It does
not upload documents to a DocumentServer callback endpoint and it cannot know
the product's final storage target. Its save contract is:

```text
OnlyOffice built-in Save button
  -> onlyoffice-browser exports native editor bin and converts it with x2t WASM
  -> createOfficeEditor(..., { onSave(file) })
  -> Piwork host writes that File back to the mounted user-space file handle
  -> onlyoffice-browser acknowledges the native Save only after host writeback succeeds
```

For user-space Office files, Piwork must treat the browser app as the
document storage service. `UserSpaceExplorer` wires `onSave(file)` to
`saveUserSpaceFile(...)`, which writes through the File System Access
`createWritable()` handle for the original user-space path. The
product UI must not add a second Office Save button outside the editor. The
OnlyOffice native toolbar owns the dirty-gated Save command, and
`onlyoffice-browser` keeps the native acknowledgement pending until the host
callback finishes.

For existing user-space files, pass `saveBehavior: "callback"` so a missing or
failed `onSave` rejects the save instead of downloading. For future blank Office
creation flows, use `emptyType` with `saveBehavior: "download"` and do not bind
the instance to a user-space path; the native Save button should create a
browser download. Do not route local persistence through OnlyOffice
`downloadAs()` or upstream autosave. The embedded OnlyOffice config disables
`autosave` and `forcesave`, forces strict co-editing, and treats the native
"All changes saved" status as true only after the browser host callback or
download path completes.

Legacy `.doc`, `.xls`, and `.ppt` files are compatibility inputs. OnlyOffice
editing output is saved as the corresponding OOXML file (`.docx`, `.xlsx`,
`.pptx`), so Piwork must create or switch to the returned OOXML path instead
of writing OOXML bytes back into the old binary extension.

OnlyOffice document resources are part of the export input, not optional
preview cache. The official DocumentServer converter downloads the whole
document storage directory into a temp `source` folder before running
FileConverter, so `Editor.bin`, changes, and `media/...` sidecar files are
available together. The browser runtime has no server storage directory, so
`onlyoffice-browser` must materialize its media object URL map back into x2t
`/working/media` before Save, Print, or Download as conversion. Regressions here
show up as OOXML packages whose XML relationships reference images while
`word/media/*`, `xl/media/*`, or `ppt/media/*` files are missing, or as printed
PDFs with black/empty image regions.

Printing uses the OnlyOffice native Print button. `onlyoffice-browser` provides
the parent `APP.printPdf` bridge, converts the editor print payload to a PDF
with x2t WASM, stores it in the editor host origin Cache API, returns a
same-host `/__onlyoffice-browser-print__/...pdf` URL, and lets the editor
continue into its print iframe and browser print flow. Printing must not call
`downloadAs()` or `onSave`. Keep the print PDF URL resource name,
`Content-Disposition` filename, and PDF document Title metadata aligned.
DocumentServer includes the filename in `/printfile/:docid/:filename` because
Chrome consults the resource name when saving printed PDFs, and Chrome's PDF
viewer can also use the PDF Title metadata. The browser runtime therefore adds
the filename to the temporary URL and writes a UTF-16BE `/Title` into generated
print PDFs.

## OnlyOffice Package Cache And Iframe Isolation

OnlyOffice runs inside a per-editor
`office-editor-<session>.getpi.work` iframe. The outer host
iframe must not have a `sandbox` attribute: the editor's native print flow loads
a generated PDF into its own `#id-print-frame` and then calls
`iframe.contentWindow.print()`, which requires script access inside the same
editor host origin. Reintroducing a sandbox can make Chrome report the nested
print frame as cross-origin even when the URL looks correct.

During local development, Piwork imports the published
`@agentbridges-ai/onlyoffice-browser` package installed under `web/node_modules`.
`web/vite.config.ts` excludes it from `optimizeDeps` and sends `no-store`
headers for its module URLs. Vite optimized dependencies use
immutable `?v=` URLs, and Chrome can keep executing an older prebundled
module after the installed package changes. If real Chrome shows
`iframe.office-editor-host-frame[sandbox]`, confirm the published npm version,
restart `make dev`, and reopen the Office iframe.

`onlyoffice-browser` has two build outputs that must stay in sync. `dist/npm`
is the package API imported by Piwork, while `dist/assets/officeHost-*.js`
and `dist/assets/converter-*.js` are the code that actually runs inside the
editor host iframe. Save, Print, Download as, and document resource fixes are
usually in the Host runtime path. Build and verify both outputs in the
`onlyoffice-browser` repository, deploy the Host and shared assets to
`onlyoffice.getpi.work`, publish the npm package when its public API changes,
then update Piwork's package and release-manifest pins. An already open editor
iframe can keep executing the previous Host bundle, so reopen it after a
deployment.

The OnlyOffice service worker is registered at the editor host root so the
native print iframe can fetch the generated PDF as a same-origin URL. It must
only handle Office runtime files and `/__onlyoffice-browser-print__/` on the
Office Host origin; Piwork never serves or registers that service worker.

Authoritative references for this behavior:

- [ONLYOFFICE callback handler](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/) defines the server model: the editor reports save statuses and the storage service downloads/writes the edited document, returning `{ "error": 0 }`.
- [ONLYOFFICE saving file](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file/) describes the same storage-service responsibility for actual persistence.
- [ONLYOFFICE/Docker-DocumentServer](https://github.com/ONLYOFFICE/Docker-DocumentServer) is the upstream runtime packaging reference for server deployments.
- [cryptpad/onlyoffice-editor](https://github.com/cryptpad/onlyoffice-editor) is the browser wrapper reference for OnlyOffice client integration.
- [agentbridges-ai/onlyoffice-x2t-wasm](https://github.com/agentbridges-ai/onlyoffice-x2t-wasm) is the maintained fork for browser-side x2t/WebAssembly build changes and releases. [cryptpad/onlyoffice-x2t-wasm](https://github.com/cryptpad/onlyoffice-x2t-wasm) is a source-analysis reference for runtime filesystem, test wiring, and wasm packaging constraints only. Do not patch or publish the CryptPad upstream from Piwork; product behavior should still be derived from ONLYOFFICE/DocumentServer.
- Browser-side Office conversion has a single engine: x2t-wasm. Do not introduce a second conversion engine, Pandoc path, or fallback converter for Download As outputs. Post-processing is allowed only after x2t-wasm has produced the requested target bytes, such as packaging Markdown image resources. If a visible OnlyOffice export format fails, fix `agentbridges-ai/onlyoffice-x2t-wasm`, x2t params, or resource materialization, then keep the failure visible until the x2t path is real.

## Data Layout

The default root is `data/` at the repository root. It is ignored by Git.

```text
data/
  .runtime/
    runtime-layout.json
  <betterAuthUserId>/
    profile.json
    preferences.json
    workspace-state.json
    pi-resources/
      skills/
    <sessionId>/
      session.json
      workspace/
      home/
      tmp/
      pi-config/
      pi-sessions/
      recordings/
      user-space-checkouts/
```

Better Auth `user.id` is used as the directory id. `profile.json` is a derived
snapshot for local introspection and is not used to authenticate users.

Pi JSONL under `pi-sessions/` is the only source of truth for conversation,
model, thinking, compaction, Plan, and Todo. `session.json` stores product
authority, archive state, the relative Pi path, offline queue metadata, and
client de-duplication only.

## Pi resources and runtime marker

Only scanned and approved user Skills under `pi-resources/skills` are loaded,
and only through explicit `--skill` paths. Workspace `.pi`, project extensions,
package resources, themes, prompt templates, and `/login` stay disabled.

A fresh empty data root receives the Pi v1 `.runtime/runtime-layout.json`
marker. A non-empty root without a valid marker refuses session launch. It is
never silently migrated or deleted.

## Frontend i18n Harness

All user-visible frontend copy is centralized in `web/src/ui-copy.ts`.
Production components must use `uiCopy` for visible labels, errors, empty and
loading states, placeholders, tooltips, `title`, and `aria-label`; literal
product copy in TSX is not allowed. Add Simplified Chinese to `zhCNCopy` and
the matching English override to `enUSCopyOverrides` in the same change.

Read `uiCopy` at render or action time so changing the active language updates
the interface. Do not capture localized values in module-scope constants.
Intentionally invariant brand, protocol, command, path, and file-format values
must be explicitly allowlisted in `web/src/i18n-harness.test.ts`. That test also
scans production TSX for hardcoded visible strings and compares static catalog
leaves to catch missing English overrides. New UI tests should assert both
`zh-CN` and `en-US` for changed copy.

## Browser-Mounted User Spaces

User Space is one active browser-authorized directory. It is not a server cwd
path and is not mirrored into an in-memory filesystem. The directory switcher
updates the browser view and the session broker as one controlled operation;
the broker keeps that directory first and injects its `rootName` into the Agent
prompt. Stale switch responses are ignored, and a failed switch restores the
previous directory.

### Harness authority

The authoritative harness reference for the public `read`, `write`, `edit`,
and `bash` tool behavior is
[earendil-works/pi](https://github.com/earendil-works/pi) `main`, specifically:

- `packages/coding-agent/src/core/tools/read.ts`
- `packages/coding-agent/src/core/tools/write.ts`
- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/edit-diff.ts`
- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/truncate.ts`
- `packages/coding-agent/src/core/tools/output-accumulator.ts`
- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`

Piwork keeps pi's public contracts, truncation and continuation messages,
exact-edit matching, atomic multi-edit behavior, BOM/line-ending handling,
mutation serialization, timeout behavior, and errors. Only the operations
layer is adapted: text files are read and changed directly through the browser
File System Access API, while shell parsing and execution use
`just-bash/browser`. Do not add MCP, host filesystem paths, text-file checkout
copies, or a second incompatible argument shape.

The Agent-facing top-level CLI intentionally contains only four pi-aligned
tools:

- `user-space read rootName/path [--offset N] [--limit N]`
- `printf 'text\n' | user-space write rootName/path`
- `user-space edit rootName/path --edits '[{"oldText":"before","newText":"after"}]'`
- `user-space bash --command <command> [--timeout N]`
- `user-space bash --capabilities`

Agent-facing paths include the active directory's exact `rootName` and do not
start with `/`, for example `office/需求调研.md`. The CLI validates and removes
that active root prefix before sending the browser operation; mount IDs and
directory-selection commands remain internal. Top-level `grep`, `glob`,
`tree`, `find`, direct Unix aliases, and `sh -c` are not public.

`read` uses pi's 1-based `offset` plus `limit`. Prompts and skills must call
that range API directly instead of piping `read` through `sed`, `head`, or
`tail`. `edit` matches every edit against the original content, requires each
match to be unique and non-overlapping, and applies the full edit set atomically.

### Browser bash capability boundary

`user-space bash` is a `just-bash/browser` parser and command emulator over the
active browser directory. It cannot discover or execute host/container
programs. `/` and `$HOME` both refer to the active User Space root.

The canonical registry is `web/src/user-space-shell-contract.ts`; use
`user-space bash --capabilities` to inspect it at runtime. Supported syntax is
limited to the tested shell surface: pipelines, redirections, heredocs/here
strings, `&&`/`||`, variables and `export`, command substitution, globs, and
subshells. Execution is capped at 500 commands, 1,000 loop iterations, call
depth 20, and 2 MiB strings.

Important exclusions and adaptations:

- No networking or sockets (`curl`, `wget`, `ssh`, `scp`, `nc`).
- No package managers, VCS, compilers, databases, language runtimes, host
  processes, devices, or services (`git`, `npm`, `npx`, `python`, `node`,
  `bun`, `sqlite3`, `make`, `docker`, and similar tools).
- Inside `user-space bash`, `grep` accepts stdin/explicit files and `-r/-R`
  delegates recursive content search to the browser file-tree index.
- `sed -i` and `awk system()` are disabled. Use `user-space edit` or `write`
  for mutations.
- `find` supports traversal plus `-maxdepth`, `-mindepth`, `-type f/-type d`,
  `-name/-iname`, `-path/-ipath`, and `-print`; it does not support `-exec`,
  `-execdir`, `-delete`, `-ok`, or `-okdir`.
- `cp` and `mv` operate on files only. Shell-created symlinks are scoped to one
  shell invocation; browser storage does not gain persistent host symlinks.

Registered commands are printed by `user-space bash --capabilities`. Agents
must consult that command rather than guessing that a familiar Unix executable
exists. Prefer top-level `read`, `write`, and `edit` for text. Within bash,
`find`, `tree`, recursive `grep`, and the indexed `glob` command own search and path
enumeration without duplicate top-level commands.

Those are capabilities of the browser shell, not permission to mutate in Plan
mode. Plan mode removes `write` and `edit`, forces child tasks read-only,
exposes only MCP tools explicitly marked `readOnly`, and applies a separate
fail-closed bash classifier. Redirects, dynamic execution, command
substitution, and unclassified syntax are rejected before the browser shell is
invoked. Plan text reads use only the strict `user-space read` form. Metadata
traversal may use one literal allowlisted command through `user-space bash`;
content search, mutation, redirects, pipelines, and compound shell remain
blocked, and User Space still performs its own authority check.

### Recursive search authority

The authoritative search reference is
[DannyMoerkerke/file-tree](https://github.com/DannyMoerkerke/file-tree)
`master`, specifically `src/iterateWorker.js` and the `indexDirectory`,
`indexFileContent`, `findInFiles`, `searchInFiles`, `findFile`, and `searchFile`
methods in `src/file-tree.js`. Its model is: recursively enumerate the selected
File System Access API directory in a Worker, keep a nested metadata index,
preload searchable text content, and perform path/content search over that
index.

Piwork extends that model without changing the browser ownership boundary:

- The metadata index recursively includes every authorized entry, including
  `.git`, `node_modules`, `dist`, hidden paths, and large files. Hidden-entry
  preferences filter display and search results, not indexing.
- `grep -r/-R` inside `user-space bash` recursively queries the same content
  index; non-recursive grep continues to accept stdin or explicit files.
- `glob 'PATTERN' [PATH]`, `find`, and `tree` inside `user-space bash` enumerate
  the complete indexed path set and honor hidden-entry preferences.
- `search`, `search_paths`, and `glob` remain internal browser-index operations
  for UI/runtime consumers. None is a public top-level Agent command.

This is a deliberate file-tree/just-bash fusion: file-tree owns recursive
enumeration and search data, while just-bash owns shell parsing and pipelines.
Search commands must not spawn or imitate host `grep`, `rg`, `find`, or `xargs`.

Text files normally stay remote and use `read`, `write`, and `edit`. Binary
files use `checkout rootName/USER_SPACE_PATH` inside `user-space bash`. The
command returns a session-relative Agent Space `shared/...` path; exit
user-space bash and use normal Agent Space tools on that exact path. It is not
`/shared` inside user-space bash and must not be rediscovered with host `find`.
`checkin shared/PATH rootName/USER_SPACE_PATH` safely replaces an explicit
destination using a fresh conflict check; omitting the destination creates a
non-destructive result under User Space `shared/`. Both are explicit,
authenticated transfer commands and never accept a host path. Private staging remains under
`data/<betterAuthUserId>/<sessionId>/user-space-checkouts`.

## Native Pi migration reset

Review the dry-run before applying the one-time incompatible session reset:

```bash
make pi-reset-legacy-sessions
CONFIRM_PI_SESSION_RESET=1 make pi-reset-legacy-sessions
```

The reset refuses an active runtime, a live runner lock, symlinked or broad
paths, unsafe Skills, and conflicting managed Skills. It migrates scanned user
Skills into `pi-resources/skills`, removes legacy sessions/config/certificates,
clears only session references from workspace state, and writes the Pi v1
marker. It preserves Better Auth/Postgres, profile/preferences, User Space
authority, tenant knowledge, and control-plane configuration.

If `PIWORK_DATA_ROOT` points outside the repository, even a dry-run requires
`CONFIRM_EXTERNAL_PI_DATA_ROOT=1`.
