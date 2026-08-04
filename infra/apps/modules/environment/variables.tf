variable "enabled" {
  description = "Create the Cloudflare OAuth client. Disabled by default."
  type        = bool
  default     = false
}

variable "account_id" {
  description = "Piwork operator Cloudflare account identifier. BYOC App resources are never created here."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.account_id == null || can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be null or a 32-character Cloudflare account identifier."
  }
}

variable "environment" {
  description = "Piwork deployment environment."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "oauth_client_name" {
  description = "Name shown on Cloudflare's OAuth consent screen."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_client_name == null || try(length(trimspace(var.oauth_client_name)) > 0, false)
    error_message = "oauth_client_name must be null or non-empty."
  }
}

variable "oauth_client_uri" {
  description = "Verified public Piwork client URL."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_client_uri == null || can(regex("^https://", var.oauth_client_uri))
    error_message = "oauth_client_uri must be null or use HTTPS."
  }
}

variable "oauth_redirect_uri" {
  description = "Exact Piwork backend OAuth callback URL."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_redirect_uri == null || can(regex("^https://", var.oauth_redirect_uri))
    error_message = "oauth_redirect_uri must be null or use HTTPS."
  }
}

variable "oauth_post_logout_redirect_uri" {
  description = "Piwork URL used after Cloudflare OAuth logout."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_post_logout_redirect_uri == null || can(regex("^https://", var.oauth_post_logout_redirect_uri))
    error_message = "oauth_post_logout_redirect_uri must be null or use HTTPS."
  }
}

variable "oauth_scope_ids" {
  description = "Cloudflare OAuth scope IDs discovered from /client/v4/oauth/scopes."
  type        = list(string)
  default     = []

  validation {
    condition = (
      length(var.oauth_scope_ids) == length(toset(var.oauth_scope_ids)) &&
      alltrue([for scope in var.oauth_scope_ids : length(trimspace(scope)) > 0])
    )
    error_message = "oauth_scope_ids must contain unique, non-empty Cloudflare OAuth scope IDs."
  }
}

variable "oauth_logo_uri" {
  description = "HTTPS logo URL required before promoting the OAuth client to public."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_logo_uri == null || can(regex("^https://", var.oauth_logo_uri))
    error_message = "oauth_logo_uri must be null or use HTTPS."
  }
}

variable "oauth_policy_uri" {
  description = "HTTPS privacy-policy URL shown by Cloudflare."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_policy_uri == null || can(regex("^https://", var.oauth_policy_uri))
    error_message = "oauth_policy_uri must be null or use HTTPS."
  }
}

variable "oauth_tos_uri" {
  description = "HTTPS Piwork terms URL shown by Cloudflare."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_tos_uri == null || can(regex("^https://", var.oauth_tos_uri))
    error_message = "oauth_tos_uri must be null or use HTTPS."
  }
}

variable "oauth_visibility" {
  description = "Set to public only after client URI verification; promotion is irreversible."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.oauth_visibility == null || var.oauth_visibility == "public"
    error_message = "oauth_visibility must be null or public."
  }
}
