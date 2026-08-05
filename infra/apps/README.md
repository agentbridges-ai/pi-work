# Piwork Apps OAuth infrastructure

These Terraform roots can create the Cloudflare OAuth client used for user-connected Cloudflare accounts. They do not create or deploy App runtime resources.

Creation is disabled by default. Set `enabled = true` only in an intentional operator-reviewed plan with all required OAuth fields supplied.

## Setup

Fetch current OAuth scope IDs from Cloudflare's `/client/v4/oauth/scopes` API and put only the required IDs in `oauth_scope_ids`. Do not hard-code guessed permission labels.

Cloudflare requires client URI verification and branding before an OAuth client can be published for external authorization. Keep `oauth_visibility = null` for the initial apply, publish the returned verification record, verify the requested scopes, then explicitly promote the client when ready.

The OAuth client secret is a sensitive Terraform output and Terraform state contains that secret. Use an encrypted, access-controlled remote backend and transfer the output directly to the production secret manager. Never place it in tfvars, source control, an App bundle, browser responses, Pi/SRT environment, or session files.

Authenticate the Cloudflare provider through an ephemeral, least-privilege operator or CI credential supplied outside Terraform variables and state.

```sh
terraform -chdir=infra/apps/staging init
terraform -chdir=infra/apps/staging fmt -check
terraform -chdir=infra/apps/staging validate
terraform -chdir=infra/apps/staging plan
```

See [`packages/apps-platform/docs/byoc-wrapper.md`](../../packages/apps-platform/docs/byoc-wrapper.md) for the Worker wrapper boundary.
