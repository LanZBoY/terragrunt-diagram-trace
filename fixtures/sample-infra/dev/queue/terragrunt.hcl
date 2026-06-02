include "root" {
  path = find_in_parent_folders("root.hcl")
}

# Read account.hcl's locals in THIS unit, then build the module source from them.
# The scanner resolves local.account.locals.* across files → a concrete git source + docs URL.
locals {
  account = read_terragrunt_config(find_in_parent_folders("account.hcl"))
}

terraform {
  source = "${local.account.locals.modules_repo}//queue?ref=${local.account.locals.module_version}"
}

dependency "vpc" {
  config_path = "../vpc"
}
