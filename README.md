# Piwork

Piwork is a local-first, multi-user paperwork workspace powered by the native
[Pi](https://github.com/earendil-works/pi) agent runtime. It combines a
Better Auth and Postgres entry point with isolated browser sessions, a private
Unix JSONL runtime channel, User Space file operations, and a narrow
OnlyOffice client boundary.

Piwork is not a hosted agent platform. It does not expose product-level Git,
worktree, pull-request, source-dashboard, or host-PTY features. Coding can be
an implementation task inside an agent session; documents, spreadsheets,
presentations, and research remain the product surface.

## Architecture

```text
Browser
  -> Caddy (the only published port)
  -> Bun/Hono Web + WebSocket server
  -> Better Auth + Postgres
  -> private Unix JSONL/HMAC runtime socket
  -> one Node + native Pi rpc-entry per session in SRT
  -> explicit trusted Piwork extension
```

Better Auth owns users, accounts, credentials, and sessions. Product state is
stored under the tenant and session paths described in `AGENTS.md`. Runtime
authority includes tenant, user, membership, and organization-node scope;
cross-tenant and cross-session path resolution fails closed.

The supported Agent runtime is the pinned
`@earendil-works/pi-coding-agent` `rpc-entry` on Node.js. The Web and Runtime
services communicate through a bounded, authenticated Unix JSONL protocol.
Credentials are delivered through a one-use in-memory bootstrap channel and
must never enter Git, arguments, child environments, logs, recordings, or Pi
JSONL.

OnlyOffice host assets and conversion services are maintained in their own
repositories. Piwork consumes the published browser client API and does not
serve, proxy, or build their host, SDK, WASM, font, or service-worker assets.

## Development

Use Linux, OrbStack Linux, WSL2, or another Linux engine for Compose and SRT.
The pinned toolchain is managed by `mise`.

```bash
make install
make selfhost-init
make dev
```

Useful checks:

```bash
make governance-check
make security-check
make landing-check
make typecheck
make test-targeted
make test
make check
```

The root checkout is read-only for concurrent work. Use the worktree harness
and run initialization and dependency installation inside each task worktree.
See [Development](docs/development.md) and [Engineering](docs/engineering/README.md).

## Contributing

Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request. Keep changes small, use an English Conventional
Commit title, and include focused tests. All checks, signatures, ownership,
and security boundaries remain required; stacked pull requests express
dependency order but never bypass review.

## Security

Report vulnerabilities through [Private Vulnerability
Reporting](https://github.com/agentbridges-ai/pi-work/security/advisories/new).
See [SECURITY.md](SECURITY.md) for the supported versions and non-negotiable
runtime boundaries.

## License

MIT. See [LICENSE](LICENSE).
