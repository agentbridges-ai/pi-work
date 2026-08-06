# Governance

Piwork uses a small maintainer model and keeps policy close to the code. The
`@agentbridges-ai/piwork-core` team owns day-to-day maintenance; contributors
participate through public issues and pull requests. The
`@agentbridges-ai/piwork-leads` team is reserved for release and emergency
administration.

## Principles

- Keep the product core small and prefer extensions or focused follow-up
  changes for optional behavior.
- Treat authentication, tenant isolation, credentials, Pi RPC/SRT, User Space,
  shared protocols, migrations, CI, security, and release automation as
  high-risk paths.
- Keep the main branch releasable. Every merge must have real or deterministic
  no-op required checks; a no-op is never a bypass.
- Use GitHub milestones and tracker issues for work that spans multiple pull
  requests. Stacked pull requests express dependency order; Merge Queue, when
  enabled, validates the combined result. Neither changes review requirements.

## Review and decisions

The source of truth for review counts, risk paths, teams, required statuses,
and exceptions is `.governance/github-policy.json`. Ordinary pull requests
require one Core approval. High-risk pull requests require two independent Core
approvals. GitHub signatures, required checks, resolved conversations, and
latest-head evidence remain mandatory for every author.

Architecture and security decisions belong in an ADR or RFC. Operational
procedures belong in `docs/runbooks/`. The machine checks validate policy,
ownership, links, exceptions, and action pinning; they do not infer authority
from usernames or organization membership.

## Changes to governance

Governance changes are normal signed pull requests. They must update the
machine policy and its documentation together, include focused fixtures, and
pass the same required checks as product changes. No workflow may silently
modify teams, rulesets, milestones, or policy files.
