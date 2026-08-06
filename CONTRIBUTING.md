# Contributing to Piwork

Piwork follows the small-core, extension-friendly contribution model used by
[Pi](https://github.com/earendil-works/pi). Read the change you submit and be
able to explain its behavior, tests, and operational impact. AI assistance is
allowed; unreviewed generated output is not.

## Before opening a pull request

1. Read `AGENTS.md` and [Development](docs/development.md).
2. Start from `origin/main` in an isolated worktree. The main checkout is
   read-only and must remain clean.
3. Keep the change focused. Product code belongs in the product; repository
   automation belongs in `.github/` or `scripts/`.
4. Run the smallest relevant local checks first, then `make check` when the
   change is ready.
5. Do not commit credentials, `.env` files, user data, recordings, build
   output, or another repository.

The worktree harness is a local coordination aid, not a product feature. It
records task scope and prevents concurrent tasks from claiming the same files.

## Pull requests

- Use an English Conventional Commit title:
  `type(scope?): short summary`.
- Describe the problem, the change, risk, tests, migration or rollback impact,
  and any documentation or accessibility impact.
- Link an ADR, RFC, issue, or runbook when the change affects a public
  contract, authentication, isolation, credentials, runtime boundaries,
  migrations, CI, security, or release behavior.
- Use squash merging. Do not bypass required checks or rewrite another
  contributor's history.

The current review policy is machine-readable in
`.governance/github-policy.json`. In summary, ordinary changes require one
Core approval and high-risk changes require two independent Core approvals.
Signatures, required checks, thread resolution, and the latest-head rule always
remain enforced.

## Local checks

```bash
make install
make governance-check
make security-check
make landing-check
make check
```

If a check cannot run locally, record the reason and the corresponding CI
evidence in the pull request. Exceptions are explicit, scoped, owned, and
time-limited in `.governance/exceptions.json`.
