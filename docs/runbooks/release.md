# Release and rollback

1. Confirm all required checks are green and Release Please has generated the
   version pull request.
2. Squash the release pull request and verify the `vX.Y.Z` tag, root
   `CHANGELOG.md`, SPDX SBOM, and `release-evidence.json`.
3. Deploy the exact Landing `out` artifact after frozen install, lint,
   typecheck, build, and smoke checks pass.
4. If a regression appears, stop subsequent releases and roll back to the
   previous verified tag. Never rewrite or force-push a release tag.

Release Please uses the repository secret `PIWORK_RELEASE_TOKEN`. The secret
must be repository-scoped, least-privilege, and rotated without copying its
value into files, logs, arguments, or environments. `make
github-governance-check` verifies only the secret name; it never reads the
secret value.

Record the release commit, manifest digest, check links, affected users, and
follow-up issue in the release evidence.
