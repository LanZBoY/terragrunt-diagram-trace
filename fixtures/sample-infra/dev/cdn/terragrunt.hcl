include "root" {
  path = find_in_parent_folders("root.hcl")
}

# Concrete remote module source — resolves to a browsable GitHub URL
# (https://github.com/acme/terraform-modules/tree/v1.4.0/cdn).
terraform {
  source = "git::git@github.com:acme/terraform-modules.git//cdn?ref=v1.4.0"
}

dependency "app" {
  config_path = "../app"
}
