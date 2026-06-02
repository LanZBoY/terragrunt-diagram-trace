# Root Terragrunt config shared by every unit via include "root".
# Discovered through find_in_parent_folders().

locals {
  region_vars  = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  modules_base = "git::git@github.com:acme/terraform-modules.git"
}

remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket = "acme-tfstate"
    key    = "${path_relative_to_include()}/terraform.tfstate"
    region = local.region_vars.locals.aws_region
  }
}
