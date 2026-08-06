# RFC-0005: CodeQL Action v4 migration

- Status: accepted
- Review cycle: 90 days
- Owner: maintainers

## Problem

Dependabot can update one CodeQL action step while leaving the other steps on
an older major version. Mixed versions can reject the generated configuration
before analysis starts.

## Decision

- The CodeQL workflow uses one complete commit SHA for `init` and `analyze`.
- JavaScript and TypeScript use `build-mode: none`.
- GitHub Actions analysis uses its own v4 matrix entry.
- Governance fixtures verify the SHA, query suite, and build-mode boundaries.

## Non-goals and rollback

This RFC does not lower the query suite, required status, or High/Critical
blocking policy. If v4 fails on the runner, restore the previous complete v3
pin in one focused PR; do not disable CodeQL or weaken the Ruleset.

## Acceptance

Action pinning, governance fixtures, YAML validation, and both matrix languages
must pass in CI.
