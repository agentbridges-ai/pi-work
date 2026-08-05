output "oauth_client_id" {
  value = module.apps.oauth_client_id
}

output "oauth_client_secret" {
  value     = module.apps.oauth_client_secret
  sensitive = true
}

output "oauth_client_uri_verification" {
  value = module.apps.oauth_client_uri_verification
}
