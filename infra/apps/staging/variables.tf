variable "enabled" {
  type    = bool
  default = false
}
variable "account_id" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_client_name" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_client_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_redirect_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_post_logout_redirect_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_scope_ids" {
  type    = list(string)
  default = []
}
variable "oauth_logo_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_policy_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_tos_uri" {
  type     = string
  default  = null
  nullable = true
}
variable "oauth_visibility" {
  type     = string
  default  = null
  nullable = true
}
