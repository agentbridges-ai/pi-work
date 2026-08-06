# ADR-0001: Engineering governance baseline

- Status: accepted
- Review cycle: 90 days
- Owner: maintainers

## Context

Piwork is a public local-first product with a native Pi runtime, Better Auth,
Postgres, browser User Space, and external OnlyOffice assets. The repository
needs strong security and release boundaries without turning contribution into
a collection of bespoke documents or opaque automation.

## Decision

Use a small, English-first governance surface modeled on Pi:

- Keep product and repository invariants in `AGENTS.md` and
  `docs/engineering/README.md`.
- Keep machine policy in `.governance/` and enforce it with focused scripts.
- Use GitHub CODEOWNERS, ordinary and high-risk native review rules, signed
  commits, required checks, and resolved conversations.
- Keep workflows deterministic and read-only by default. A path-independent
  job reports a no-op instead of disappearing.
- Use isolated worktrees for concurrent development and GitHub milestones for
  multi-PR delivery. Execution tasks return evidence; merge authority remains
  with the repository maintainers.
- Treat stacked pull requests as dependency metadata and Merge Queue as a
  combined validation tool, never as an approval bypass.

## Consequences

The public rules are shorter and role-based. Product-specific security checks,
runtime canaries, release evidence, and deferred RFCs remain explicit because
they protect real boundaries. A future change to authentication, isolation,
runtime, migration, deployment, or release behavior must update the relevant
machine policy and focused evidence in the same pull request.
