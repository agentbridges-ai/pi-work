# Engineering

Piwork keeps engineering guidance short and close to the repository. The
project follows the minimal, extension-friendly governance model used by
[Pi](https://github.com/earendil-works/pi): contributors read the rules,
understand their changes, run the documented checks, and submit focused pull
requests.

## Sources of truth

- `AGENTS.md` contains repository and product invariants.
- `CONTRIBUTING.md` describes the public contribution path.
- `.governance/` contains machine-readable policy, controls, exceptions,
  licensing, and worktree coordination data.
- `.github/` contains ownership, issue forms, pull request templates, and
  required workflows.
- `docs/adr/` records accepted architectural decisions.
- `docs/rfcs/` records proposals and deferred changes.
- `docs/runbooks/` records recovery, incident, credential, and release steps.
- `docs/development.md` is the practical development guide.

The upstream Pi source is a reference only; it is not vendored as a submodule.
Product behavior and security boundaries remain specific to Piwork.

## Required boundaries

- Keep the core product small. Prefer an extension or a focused follow-up PR
  for optional behavior.
- Keep Server, Browser, Shared, Runtime, and Landing dependencies one-way.
- Treat authentication, tenant isolation, credentials, Pi RPC/SRT, User Space,
  shared protocols, migrations, CI, security, and release code as high risk.
- Use the existing native Pi runtime and the fixed Compose surface. Do not add
  another Agent runtime, host terminal, Docker socket, or product-level Git
  workflow.
- Keep secrets out of Git, arguments, child environments, logs, recordings,
  and session JSONL.

## Delivery

Use the smallest relevant local check first, then the complete check before a
push. Every required status must report either a real check or a deterministic
no-op. Stacked pull requests express dependency order; Merge Queue validates a
combined commit when enabled. Neither mechanism changes review or security
requirements. `governance-review.yml` is a read-only compatibility status for
the existing remote Ruleset and can be retired after an administrator reads
back the replacement policy.

The worktree harness keeps concurrent tasks in separate directories, rejects
the root checkout, detects scope overlap, and retains dirty or unpushed work.
It is a development aid, not a product feature and not a review bypass.

## Decisions and exceptions

Create an ADR for an accepted architectural decision and an RFC for a change
that needs design, migration, or operational evidence. Keep deferred work
explicit rather than adding speculative infrastructure. Exceptions must have
an owner, a public tracking issue, a reason, and an expiry in
`.governance/exceptions.json`.

Run `make governance-check` after changing this page, `.governance/`, or
`.github/`. The check verifies policy, ownership, issue forms, links, and
action pinning without requiring a private organization membership list.
