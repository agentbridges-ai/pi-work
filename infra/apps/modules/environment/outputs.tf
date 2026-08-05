output "oauth_client_id" {
  value = try(cloudflare_oauth_client.apps_byoc[0].client_id, null)
}

output "oauth_client_secret" {
  value     = try(cloudflare_oauth_client.apps_byoc[0].client_secret, null)
  sensitive = true
}

output "oauth_client_uri_verification" {
  value = try(cloudflare_oauth_client.apps_byoc[0].client_uri_verification, null)
}
