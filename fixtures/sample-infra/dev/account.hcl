# Shared account-level values, read by units via read_terragrunt_config(). Demonstrates a
# cross-file locals chain that the scanner can resolve statically (no include merge needed).
locals {
  modules_repo   = "git::git@github.com:acme/mods.git"
  module_version = "v2.0.0"
}
