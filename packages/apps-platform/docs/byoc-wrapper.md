# BYOC Worker deployment boundary

Piwork deploys a wrapped, ordinary Cloudflare Worker to a Cloudflare account that the user connected through OAuth.

The trusted backend owns the deployment lifecycle:

1. Resolve a short-lived OAuth access credential for the selected connection.
2. Validate the App bundle and the exact manifest-approved binding plan.
3. Create or verify declared resources in the selected account.
4. Bundle this package's wrapper around the App module.
5. Upload the Worker and Workers Static Assets using Cloudflare's ordinary APIs.
6. Persist non-secret resource receipts and the resulting deployment version.

OAuth access and refresh credentials stay encrypted in the server-side control plane. They must not enter the App bundle, Pi/SRT environment, session files, logs, screenshots, analytics, Terraform variables, or browser responses.

The wrapper is deliberately small. It validates its immutable configuration, hides undeclared bindings, strips Piwork-shaped and authentication headers, protects reserved paths, and invokes the App's default module handler. Account selection, OAuth, resource provisioning, rollback, explicit domain detach, and deployment-step observability remain trusted-backend responsibilities. Archiving an App only unlinks it from Piwork; it does not delete resources from the user's Cloudflare account.

Artifacts live in Piwork-owned immutable storage so rollback uploads an already validated bundle without rebuilding source. Rollback changes code and its binding declaration, not stored KV, D1, R2, or Durable Object data.

The Workers Vitest pool tests the wrapper in the real Workers runtime compatibility layer. Wrangler dry-run validates the generated ordinary Worker upload shape.
