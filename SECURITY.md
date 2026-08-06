# Security policy

## Reporting a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/agentbridges-ai/pi-work/security/advisories/new).
Do not disclose exploitable details in a public issue, pull request,
discussion, log, recording, or session file.

Include the affected version or commit, a reproducible description, impact,
and any temporary mitigation. The maintainers target acknowledgement within
three business days and initial triage within seven calendar days. Target
remediation windows are seven days for Critical, 30 days for High, and 90 days
for Medium findings; Low findings are scheduled with normal maintenance.

## Non-negotiable boundaries

- Better Auth and Postgres are the only product authentication path.
- User data stays under the tenant and session paths documented in `AGENTS.md`.
- Credentials must not appear in Git, command-line arguments, child-process
  environments, logs, recordings, or Pi JSONL.
- The native Pi runtime, trusted extension, and managed MCP surface are the
  only supported Agent runtime boundaries.
- New network, filesystem, MCP, runtime, or deployment capabilities require a
  threat assessment and high-risk review.
- Security exceptions are explicit, owned, approved, scoped, and expire within
  30 days.

## Supported versions

The latest `main` release and the previous SemVer minor are supported. A
vulnerability affecting a supported release enters the normal security queue.
