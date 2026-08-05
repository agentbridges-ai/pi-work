resource "cloudflare_oauth_client" "apps_byoc" {
  count = var.enabled ? 1 : 0

  account_id                 = var.enabled ? var.account_id : "00000000000000000000000000000000"
  client_name                = var.enabled ? var.oauth_client_name : "Piwork Apps OAuth disabled"
  client_uri                 = var.enabled ? var.oauth_client_uri : "https://disabled.invalid"
  logo_uri                   = var.oauth_logo_uri
  policy_uri                 = var.oauth_policy_uri
  tos_uri                    = var.oauth_tos_uri
  redirect_uris              = var.enabled ? [var.oauth_redirect_uri] : ["https://disabled.invalid/oauth/callback"]
  post_logout_redirect_uris  = var.enabled ? [var.oauth_post_logout_redirect_uri] : ["https://disabled.invalid/apps"]
  grant_types                = ["authorization_code", "refresh_token"]
  response_types             = ["code"]
  token_endpoint_auth_method = "client_secret_basic"
  scopes                     = var.enabled ? var.oauth_scope_ids : ["disabled"]
  visibility                 = var.oauth_visibility

  lifecycle {
    precondition {
      condition = !var.enabled || (
        var.account_id != null &&
        var.oauth_client_name != null &&
        var.oauth_client_uri != null &&
        var.oauth_redirect_uri != null &&
        var.oauth_post_logout_redirect_uri != null &&
        length(var.oauth_scope_ids) > 0
      )
      error_message = "OAuth client settings are required when Apps OAuth infrastructure is enabled."
    }
  }
}
