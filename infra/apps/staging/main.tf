module "apps" {
  source = "../modules/environment"

  enabled                        = var.enabled
  account_id                     = var.account_id
  environment                    = "staging"
  oauth_client_name              = var.oauth_client_name
  oauth_client_uri               = var.oauth_client_uri
  oauth_redirect_uri             = var.oauth_redirect_uri
  oauth_post_logout_redirect_uri = var.oauth_post_logout_redirect_uri
  oauth_scope_ids                = var.oauth_scope_ids
  oauth_logo_uri                 = var.oauth_logo_uri
  oauth_policy_uri               = var.oauth_policy_uri
  oauth_tos_uri                  = var.oauth_tos_uri
  oauth_visibility               = var.oauth_visibility
}
