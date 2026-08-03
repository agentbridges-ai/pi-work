# Piwork compatibility matrix

This file is the checked-in support contract for local development and release
verification. Exact versions remain pinned where reproducibility requires it.
The Agent runtime is the exact native Pi release below; no alternate runtime or
fallback is supported.

| Surface                                                   | Pinned / supported version                                               | Verification                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Bun                                                       | `1.3.9`                                                                  | `scripts/verify-toolchain.sh`, `web/bun.lock`                                                        |
| Node.js                                                   | `>= 22.19.0` (CI: exact `26.5.0`)                                        | shared `.github/actions/setup-toolchain`, `scripts/verify-toolchain.sh`                              |
| PostgreSQL                                                | `16.x` (baseline `16.14`)                                                | `pg_dump`/`pg_restore` backup verification and integration environment                               |
| `@earendil-works/pi-coding-agent`                         | `0.82.1`                                                                 | exact manifest/lock pin, `rpc-entry` export, RPC contract and real Linux SRT smoke                   |
| `@modelcontextprotocol/sdk`                               | `1.29.0`                                                                 | exact manifest/lock pin; Piwork-owned stdio/SSE/Streamable HTTP transports                           |
| `@anthropic-ai/sandbox-runtime`                           | `0.0.65`                                                                 | exact manifest/lock pin, filesystem canary and real native Pi Linux smoke                            |
| Better Auth runtime and CLI                               | `1.6.20`                                                                 | exact package/CLI pin and frozen Bun lockfile                                                        |
| `agentbridges-ai/agent-browser` Chrome extension provider | `0.31.1` at `6ee4f5bcd6010af4927b2fc274878323504141ed`                   | `release/agent-browser-release-manifest.json`, `make agent-browser-verify`, `make agent-browser-e2e` |
| `@agentbridges-ai/onlyoffice-browser`                     | `0.5.8`                                                                  | exact manifest/lock pin, release v5 identity, canonical Broker and Office integration tests          |
| OnlyOffice x2t WASM                                       | `v9.3.0+2`                                                               | pinned commit and browser artifact digests in the release manifest                                   |
| ONLYOFFICE DocumentServer reference                       | `9.3.0`                                                                  | generated font metadata and browser-runtime compatibility work                                       |
| Browser / PWA                                             | Current stable desktop Chromium (Chrome, Edge, Chromium-family browsers) | platform gate tests, production asset tests, production build, real Chromium smoke test              |

Pi's sole allowed upstream `@mariozechner` package is its optional
`@mariozechner/clipboard@0.3.9`. It is not a Piwork direct dependency and
source must not import it. Development and CI install platform-specific optional
toolchain packages from the frozen lockfile; the runtime still must not load or
expose the clipboard package.
Other `@mariozechner` Pi packages,
forks, alternate Agent transports, and SDK proxy fallbacks are unsupported.

The three-repository Office release order is fixed:

1. `agentbridges-ai/onlyoffice-x2t-wasm`
2. `agentbridges-ai/onlyoffice-browser`
3. `agentbridges-ai/Piwork`

Only `@agentbridges-ai/onlyoffice-browser` is published to npm. The release
manifest records immutable commits and artifact hashes; version labels or a
moving `main` branch are not accepted as source identity.

At runtime, the isolated editor host must report the same package version,
`hostBuildId`, and SHA-256 digest of `onlyoffice-runtime-assets.json` recorded
in the release manifest. Piwork rebuilds a mismatched iframe once with a
cache-busted host URL, then refuses to transfer document bytes if the identity
is still incompatible. Updating host behavior therefore requires rebuilding
both the real `officeHost-*` asset and the npm proxy API before release.

## Browser support contract

Piwork supports desktop Chromium only. Safari, Firefox, application-embedded
web views, phones, and tablets are explicitly unsupported, even if a browser or
operating system offers its own generic "install site as app" feature. The
runtime gate is a product compatibility boundary, not an authentication or
security boundary.

The production PWA uses the stable local origin on port `3456`, registers
`/piwork-sw.js`, and never takes ownership of OnlyOffice's `/sw.js`. It caches
only the public offline explanation and application identity assets. Better
Auth, APIs, WebSockets, user-space data, document content, fonts, WebAssembly,
and OnlyOffice assets remain network-only. A waiting worker is activated only
after the user asks to update and all registered unsaved-editor guards pass.

## Runtime recording defaults

Development recording defaults to enabled. Production recording defaults to
disabled and requires the user to opt in explicitly with `PIWORK_RECORD=1`.
Recordings contain redacted Pi RPC JSONL, lifecycle, and extension events.
The supported retention envelope is 7 days, 100 MiB per session
(`104857600` bytes), and 1 GiB per user (`1073741824` bytes).

## Updating the matrix

1. Update the exact tool or package pin and its lockfile when that surface is pinned.
2. For an OnlyOffice change, build, test, and deploy the runtime from the
   `onlyoffice-browser` repository before changing Piwork.
3. Update Piwork's published npm package pin and the deployed runtime identity
   in `release/onlyoffice-release-manifest.json`.
4. Run `make verify`, then the affected real-browser smoke suite against the
   deployed Office Host.

Native Pi release evidence additionally requires
`make verify-pi-versions verify-pi-only-runtime test-pi-rpc-contract
test-srt-pi`. The last target must execute on Linux and launches the real
pinned `rpc-entry` inside the pinned SRT; a mocked child or host-only RPC probe
is not release evidence.

The agent-browser provider is consumed from the pinned source branch because
the Chrome extension package is not yet a published Piwork runtime
dependency. Updating it requires changing the immutable commit in
`release/agent-browser-release-manifest.json`, rebuilding the provider and
unpacked extension, and passing the no-fallback real Chrome E2E test.

The browser-control-loop commit is temporarily fetched from the contributor
fork recorded in the release manifest while
[`agentbridges-ai/agent-browser#1`](https://github.com/agentbridges-ai/agent-browser/pull/1)
is under review. After it merges, repin the same content (or its upstream merge
commit) to the organization repository before a production release.
